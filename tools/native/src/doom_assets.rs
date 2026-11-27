//! Freedoom E1M1 WAD baker, atlas/mesh/WAV emitter, and Blot map generator for
//! the 1:1 Mini Doom Pen WebGPU demo (matching Goose's `31_mini_doom.goose`).

use anyhow::{Context, Result, bail, ensure};
use std::collections::HashMap;
use std::path::Path;

const ATLAS_W: usize = 2048;
const ATLAS_H: usize = 2048;

pub const SOUND_NAMES: [&str; 12] = [
    "DSPISTOL", "DSSHOTGN", "DSPUNCH", "DSPLPAIN", "DSITEMUP", "DSWPNUP", "DSDOROPN", "DSPSTART",
    "DSSWTCHN", "DSFIRSHT", "DSBAREXP", "DSPODTH1",
];

#[derive(Clone)]
struct Lump {
    name: String,
    start: usize,
    size: usize,
}

#[derive(Clone)]
struct Picture {
    name: String,
    kind: u8, // 0: patch, 1: wall texture, 2: flat
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    left: i32,
    top: i32,
}

#[derive(Clone)]
struct Side {
    offset_x: f32,
    offset_y: f32,
    upper: i32,
    lower: i32,
    middle: i32,
    sector: usize,
}

#[derive(Clone)]
struct Line {
    va: usize,
    vb: usize,
    a: [f32; 2],
    b: [f32; 2],
    flags: u16,
    special: u16,
    tag: u16,
    front: usize,
    back: i32,
}

#[derive(Clone)]
struct Sector {
    floor: i16,
    ceiling: i16,
    floor_pic: i32,
    ceiling_pic: i32,
    floor_name: String,
    ceiling_name: String,
    light_byte: u8,
    special: i16,
    tag: i16,
}

#[derive(Clone)]
struct Seg {
    a: [f32; 2],
    b: [f32; 2],
    sector: usize,
}

#[derive(Clone)]
struct Subsector {
    first: usize,
    count: usize,
    sector: usize,
}

#[derive(Clone)]
struct BspNode {
    ox: i16,
    oy: i16,
    dx: i16,
    dy: i16,
    front: u16,
    back: u16,
}

#[derive(Clone)]
struct FloorTriangle {
    a: [f32; 2],
    b: [f32; 2],
    c: [f32; 2],
    sector: usize,
}

#[derive(Clone)]
struct Thing {
    x: i16,
    y: i16,
    angle: i16,
    kind: u16,
    flags: u16,
}

pub struct BakedDoom {
    atlas_rgba: Vec<u8>,
    pictures: Vec<Picture>,
    sky_picture: i32,
    vertices: Vec<[i16; 2]>,
    sides: Vec<Side>,
    lines: Vec<Line>,
    sectors: Vec<Sector>,
    subsectors: Vec<Subsector>,
    nodes: Vec<BspNode>,
    floor_triangles: Vec<FloorTriangle>,
    things: Vec<Thing>,
    wav_clips: Vec<Vec<u8>>,
    /// Per-linedef 1-based switch slot (0 = not a switch).
    line_switch_slot: Vec<u32>,
    /// Atlas rects `[x, y, w, h]` of the `SW2*` active texture for each switch slot.
    switch_on_rects: Vec<[f32; 4]>,
}

fn u16le(data: &[u8], at: usize) -> Result<u16> {
    ensure!(at + 2 <= data.len(), "truncated u16 at {at}");
    Ok(u16::from_le_bytes([data[at], data[at + 1]]))
}

fn i16le(data: &[u8], at: usize) -> Result<i16> {
    ensure!(at + 2 <= data.len(), "truncated i16 at {at}");
    Ok(i16::from_le_bytes([data[at], data[at + 1]]))
}

fn u32le(data: &[u8], at: usize) -> Result<u32> {
    ensure!(at + 4 <= data.len(), "truncated u32 at {at}");
    Ok(u32::from_le_bytes([
        data[at],
        data[at + 1],
        data[at + 2],
        data[at + 3],
    ]))
}

fn name_at(data: &[u8], at: usize) -> Result<String> {
    ensure!(at + 8 <= data.len(), "truncated name at {at}");
    let slice = &data[at..at + 8];
    let end = slice.iter().position(|&b| b == 0).unwrap_or(8);
    Ok(String::from_utf8_lossy(&slice[..end]).to_ascii_uppercase())
}

fn cross2(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}

fn sub2(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

fn dist2(a: [f32; 2], b: [f32; 2]) -> f32 {
    let d = sub2(a, b);
    (d[0] * d[0] + d[1] * d[1]).sqrt()
}

fn clip_polygon(poly: &[[f32; 2]], origin: [f32; 2], delta: [f32; 2], out: &mut Vec<[f32; 2]>) {
    if poly.is_empty() {
        return;
    }
    let mut previous = poly[poly.len() - 1];
    let mut d0 = cross2(delta, sub2(previous, origin));
    for &current in poly {
        let d1 = cross2(delta, sub2(current, origin));
        if (d0 <= 0.0) != (d1 <= 0.0) {
            let t = d0 / (d0 - d1);
            out.push([
                previous[0] + (current[0] - previous[0]) * t,
                previous[1] + (current[1] - previous[1]) * t,
            ]);
        }
        if d1 <= 0.0 {
            out.push(current);
        }
        previous = current;
        d0 = d1;
    }
}

fn build_floors(
    child: usize,
    poly: &[[f32; 2]],
    depth: usize,
    nodes: &[BspNode],
    subsectors: &[Subsector],
    segs: &[Seg],
    out_tris: &mut Vec<FloorTriangle>,
) -> Result<()> {
    ensure!(depth <= nodes.len(), "cyclic BSP tree");
    if poly.len() < 3 {
        return Ok(());
    }
    if child >= 32768 {
        let leaf_idx = child - 32768;
        ensure!(leaf_idx < subsectors.len(), "bad floor leaf");
        let leaf = &subsectors[leaf_idx];
        let mut cur: Vec<[f32; 2]> = poly.to_vec();
        let mut next: Vec<[f32; 2]> = Vec::new();
        for i in 0..leaf.count {
            let edge = &segs[leaf.first + i];
            next.clear();
            clip_polygon(&cur, edge.a, sub2(edge.b, edge.a), &mut next);
            std::mem::swap(&mut cur, &mut next);
        }
        if cur.len() >= 3 {
            for i in 1..cur.len() - 1 {
                let area2 = cross2(sub2(cur[i], cur[0]), sub2(cur[i + 1], cur[0]));
                if area2.abs() > 0.1 {
                    // Enforce CCW in 2D map space (normal +Y in 3D world space).
                    if area2 > 0.0 {
                        out_tris.push(FloorTriangle {
                            a: cur[0],
                            b: cur[i],
                            c: cur[i + 1],
                            sector: leaf.sector,
                        });
                    } else {
                        out_tris.push(FloorTriangle {
                            a: cur[0],
                            b: cur[i + 1],
                            c: cur[i],
                            sector: leaf.sector,
                        });
                    }
                }
            }
        }
    } else {
        ensure!(child < nodes.len(), "bad floor node");
        let n = &nodes[child];
        let origin = [f32::from(n.ox), f32::from(n.oy)];
        let delta = [f32::from(n.dx), f32::from(n.dy)];
        let mut right = Vec::new();
        clip_polygon(poly, origin, delta, &mut right);
        build_floors(
            usize::from(n.front),
            &right,
            depth + 1,
            nodes,
            subsectors,
            segs,
            out_tris,
        )?;
        let mut left = Vec::new();
        clip_polygon(poly, origin, [-delta[0], -delta[1]], &mut left);
        build_floors(
            usize::from(n.back),
            &left,
            depth + 1,
            nodes,
            subsectors,
            segs,
            out_tris,
        )?;
    }
    Ok(())
}

fn thing_picture_name(kind: u16) -> Option<&'static str> {
    Some(match kind {
        3004 => "POSSA1",
        9 => "SPOSA1",
        3001 => "TROOA1",
        3002 | 58 => "SARGA1",
        2001 => "SHOTA0",
        2002 => "MGUNA0",
        2003 => "LAUNA0",
        2004 => "PLASA0",
        2005 => "CSAWA0",
        2006 => "BFUGA0",
        2007 => "CLIPA0",
        2008 => "SHELA0",
        2010 => "ROCKA0",
        2046 => "BROKA0",
        2047 => "CELLA0",
        2048 => "AMMOA0",
        2049 => "SBOXA0",
        17 => "CELPA0",
        8 => "BPAKA0",
        2011 => "STIMA0",
        2012 => "MEDIA0",
        2013 => "SOULA0",
        2014 => "BON1A0",
        2015 => "BON2A0",
        2018 => "ARM1A0",
        2019 => "ARM2A0",
        2023 => "PSTRA0",
        5 => "BKEYA0",
        2035 => "BAR1A0",
        2028 => "COLUA0",
        43 => "TRE1A0",
        54 => "TRE2A0",
        47 => "SMITA0",
        48 => "ELECA0",
        10 | 12 => "PLAYW0",
        15 => "PLAYN0",
        18 => "POSSL0",
        19 => "SPOSL0",
        20 => "TROOM0",
        21 => "SARGN0",
        24 => "POL5A0",
        26 => "POL6A0",
        60 => "GOR4A0",
        _ => return None,
    })
}

fn encode_mono_pcm16_wav(rate: u32, samples: &[i16]) -> Vec<u8> {
    let data_bytes = (samples.len() * 2) as u32;
    let riff_size = 36 + data_bytes;
    let mut out = Vec::with_capacity(44 + data_bytes as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // format = PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels = 1
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for &s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

struct AtlasBuilder {
    pixels: Vec<u8>,
    pictures: Vec<Picture>,
    palette: [u8; 768],
    shelf_x: usize,
    shelf_y: usize,
    shelf_h: usize,
}

impl AtlasBuilder {
    fn new(pal: &[u8]) -> Result<Self> {
        ensure!(pal.len() >= 768, "truncated PLAYPAL");
        let mut palette = [0u8; 768];
        palette.copy_from_slice(&pal[..768]);
        let mut b = Self {
            pixels: vec![0u8; ATLAS_W * ATLAS_H * 4],
            pictures: Vec::new(),
            palette,
            shelf_x: 0,
            shelf_y: 0,
            shelf_h: 0,
        };
        let white = b.new_picture("WHITE", 0, 1, 1)?;
        assert_eq!(white, 0);
        b.pixels[0..4].copy_from_slice(&[255, 255, 255, 255]);
        Ok(b)
    }

    fn find_picture(&self, name: &str, kind: u8) -> Option<usize> {
        self.pictures
            .iter()
            .position(|p| p.kind == kind && p.name == name)
    }

    fn new_picture(&mut self, name: &str, kind: u8, w: usize, h: usize) -> Result<usize> {
        ensure!(
            w > 0 && h > 0 && w <= ATLAS_W && h <= 1024,
            "bad picture dimensions {name} {w}x{h}"
        );
        if self.shelf_x + w > ATLAS_W {
            self.shelf_x = 0;
            self.shelf_y += self.shelf_h;
            self.shelf_h = 0;
        }
        ensure!(
            self.shelf_y + h <= ATLAS_H,
            "doom picture atlas full at {} + {} > {}",
            self.shelf_y,
            h,
            ATLAS_H
        );
        let id = self.pictures.len();
        self.pictures.push(Picture {
            name: name.to_string(),
            kind,
            x: self.shelf_x as i32,
            y: self.shelf_y as i32,
            w: w as i32,
            h: h as i32,
            left: 0,
            top: 0,
        });
        self.shelf_x += w;
        self.shelf_h = self.shelf_h.max(h);
        Ok(id)
    }

    fn put_pixel(&mut self, pic: usize, x: i32, y: i32, color: u8) {
        let p = &self.pictures[pic];
        if x < 0 || y < 0 || x >= p.w || y >= p.h {
            return;
        }
        let at = (((p.y + y) as usize) * ATLAS_W + ((p.x + x) as usize)) * 4;
        let c = usize::from(color) * 3;
        self.pixels[at] = self.palette[c];
        self.pixels[at + 1] = self.palette[c + 1];
        self.pixels[at + 2] = self.palette[c + 2];
        self.pixels[at + 3] = 255;
    }

    fn paint_patch(&mut self, pic: usize, data: &[u8], origin_x: i32, origin_y: i32) -> Result<()> {
        let w = usize::from(u16le(data, 0)?);
        ensure!(8 + w * 4 <= data.len(), "truncated patch columns");
        for x in 0..w {
            let mut at = u32le(data, 8 + x * 4)? as usize;
            let mut previous: i32 = -1;
            loop {
                ensure!(at < data.len(), "unterminated patch column");
                let mut top = i32::from(data[at]);
                if top == 255 {
                    break;
                }
                ensure!(at + 4 <= data.len(), "truncated patch post");
                let count = usize::from(data[at + 1]);
                ensure!(at + count + 4 <= data.len(), "truncated patch pixels");
                if top <= previous {
                    top += previous;
                }
                previous = top;
                for y in 0..count {
                    self.put_pixel(
                        pic,
                        origin_x + x as i32,
                        origin_y + top + y as i32,
                        data[at + 3 + y],
                    );
                }
                at += count + 4;
            }
        }
        Ok(())
    }

    fn load_patch(&mut self, name: &str, data: &[u8]) -> Result<usize> {
        if let Some(id) = self.find_picture(name, 0) {
            return Ok(id);
        }
        let w = usize::from(u16le(data, 0)?);
        let h = usize::from(u16le(data, 2)?);
        let left = i32::from(i16le(data, 4)?);
        let top = i32::from(i16le(data, 6)?);
        let id = self.new_picture(name, 0, w, h)?;
        self.pictures[id].left = left;
        self.pictures[id].top = top;
        self.paint_patch(id, data, 0, 0)?;
        Ok(id)
    }

    fn load_flat<'a>(
        &mut self,
        name: &str,
        wad_lump: impl Fn(&str) -> Result<&'a [u8]>,
    ) -> Result<i32> {
        if name == "F_SKY1" {
            return Ok(-1);
        }
        if let Some(id) = self.find_picture(name, 2) {
            return Ok(id as i32);
        }
        let data = wad_lump(name)?;
        ensure!(data.len() == 4096, "flat {name} must be 64x64");
        let id = self.new_picture(name, 2, 64, 64)?;
        for y in 0..64 {
            for x in 0..64 {
                self.put_pixel(id, x as i32, y as i32, data[y * 64 + x]);
            }
        }
        Ok(id as i32)
    }

    fn wall_texture(&self, name: &str) -> Result<i32> {
        if name == "-" {
            return Ok(-1);
        }
        let id = self
            .find_picture(name, 1)
            .with_context(|| format!("missing wall texture {name}"))?;
        Ok(id as i32)
    }
}

pub fn wad_path(root: &Path) -> std::path::PathBuf {
    root.join("tools/assets/freedoom1-e1m1.wad")
}

pub fn bake_e1m1(root: &Path) -> Result<BakedDoom> {
    let path = wad_path(root);
    let wad = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    ensure!(wad.len() >= 12, "truncated WAD header");
    let sig = &wad[0..4];
    ensure!(sig == b"IWAD" || sig == b"PWAD", "expected a Doom WAD");
    let count = u32le(&wad, 4)? as usize;
    let directory = u32le(&wad, 8)? as usize;
    ensure!(
        count <= 100_000 && directory + count * 16 <= wad.len(),
        "bad WAD directory"
    );
    let mut lumps = Vec::with_capacity(count);
    for i in 0..count {
        let at = directory + i * 16;
        let start = u32le(&wad, at)? as usize;
        let size = u32le(&wad, at + 4)? as usize;
        let name = name_at(&wad, at + 8)?;
        ensure!(start + size <= wad.len(), "lump {name} extends past WAD");
        lumps.push(Lump { name, start, size });
    }

    let find_lump = |name: &str| -> Option<usize> { lumps.iter().rposition(|l| l.name == name) };
    let lump = |name: &str| -> Result<&[u8]> {
        let i = find_lump(name).with_context(|| format!("missing WAD lump {name}"))?;
        let l = &lumps[i];
        Ok(&wad[l.start..l.start + l.size])
    };
    ensure!(find_lump("E1M1").is_some(), "missing E1M1 marker");

    let mut atlas = AtlasBuilder::new(lump("PLAYPAL")?)?;

    // Wall textures from PNAMES + TEXTURE1.
    let pnames = lump("PNAMES")?;
    let name_count = u32le(pnames, 0)? as usize;
    ensure!(4 + name_count * 8 <= pnames.len(), "truncated PNAMES");
    let textures = lump("TEXTURE1")?;
    let tex_count = u32le(textures, 0)? as usize;
    ensure!(4 + tex_count * 4 <= textures.len(), "truncated TEXTURE1");
    for i in 0..tex_count {
        let at = u32le(textures, 4 + i * 4)? as usize;
        let name = name_at(textures, at)?;
        let w = usize::from(u16le(textures, at + 12)?);
        let h = usize::from(u16le(textures, at + 14)?);
        let id = atlas.new_picture(&name, 1, w, h)?;
        let patches = usize::from(u16le(textures, at + 20)?);
        ensure!(
            at + 22 + patches * 10 <= textures.len(),
            "truncated texture patches"
        );
        for j in 0..patches {
            let p = at + 22 + j * 10;
            let ox = i32::from(i16le(textures, p)?);
            let oy = i32::from(i16le(textures, p + 2)?);
            let number = usize::from(u16le(textures, p + 4)?);
            ensure!(number < name_count, "bad PNAMES index");
            let patch_name = name_at(pnames, 4 + number * 8)?;
            atlas.paint_patch(id, lump(&patch_name)?, ox, oy)?;
        }
    }

    // Sprites S_START..S_END.
    let s_start = find_lump("S_START").context("missing S_START")?;
    let s_end = find_lump("S_END").context("missing S_END")?;
    ensure!(s_end > s_start, "bad S_START/S_END");
    for l in &lumps[s_start + 1..s_end] {
        if l.size > 0 {
            atlas.load_patch(&l.name, &wad[l.start..l.start + l.size])?;
        }
    }
    for c in 33..96u32 {
        let nm = format!("STCFN{c:03}");
        atlas.load_patch(&nm, lump(&nm)?)?;
    }
    for nm in [
        "STBAR", "STFST00", "STFST10", "STFST20", "STFST30", "STFST40", "STFDEAD0",
    ] {
        atlas.load_patch(nm, lump(nm)?)?;
    }
    let sky_picture = atlas.wall_texture("SKY1")?;
    for nm in [
        "NUKAGE1", "NUKAGE2", "NUKAGE3", "FWATER1", "FWATER2", "FWATER3", "FWATER4",
    ] {
        atlas.load_flat(nm, lump)?;
    }

    // Load E1M1 map records.
    let records = |name: &str, size: usize| -> Result<&[u8]> {
        let d = lump(name)?;
        ensure!(!d.is_empty() && d.len() % size == 0, "bad {name} size");
        Ok(d)
    };
    let v_bytes = records("VERTEXES", 4)?;
    let mut vertices = Vec::with_capacity(v_bytes.len() / 4);
    for i in 0..v_bytes.len() / 4 {
        vertices.push([i16le(v_bytes, i * 4)?, i16le(v_bytes, i * 4 + 2)?]);
    }

    let sec_bytes = records("SECTORS", 26)?;
    let mut sectors = Vec::with_capacity(sec_bytes.len() / 26);
    for i in 0..sec_bytes.len() / 26 {
        let at = i * 26;
        let floor = i16le(sec_bytes, at)?;
        let ceiling = i16le(sec_bytes, at + 2)?;
        let floor_name = name_at(sec_bytes, at + 4)?;
        let ceiling_name = name_at(sec_bytes, at + 12)?;
        let floor_pic = atlas.load_flat(&floor_name, lump)?;
        let ceiling_pic = atlas.load_flat(&ceiling_name, lump)?;
        let light_byte = i16le(sec_bytes, at + 20)?.clamp(0, 255) as u8;
        let special = i16le(sec_bytes, at + 22)?;
        let tag = i16le(sec_bytes, at + 24)?;
        sectors.push(Sector {
            floor,
            ceiling,
            floor_pic,
            ceiling_pic,
            floor_name,
            ceiling_name,
            light_byte,
            special,
            tag,
        });
    }

    let sd_bytes = records("SIDEDEFS", 30)?;
    let mut sides = Vec::with_capacity(sd_bytes.len() / 30);
    for i in 0..sd_bytes.len() / 30 {
        let at = i * 30;
        let sector = usize::from(u16le(sd_bytes, at + 28)?);
        ensure!(sector < sectors.len(), "bad sidedef sector");
        sides.push(Side {
            offset_x: f32::from(i16le(sd_bytes, at)?),
            offset_y: f32::from(i16le(sd_bytes, at + 2)?),
            upper: atlas.wall_texture(&name_at(sd_bytes, at + 4)?)?,
            lower: atlas.wall_texture(&name_at(sd_bytes, at + 12)?)?,
            middle: atlas.wall_texture(&name_at(sd_bytes, at + 20)?)?,
            sector,
        });
    }

    let ld_bytes = records("LINEDEFS", 14)?;
    let mut lines = Vec::with_capacity(ld_bytes.len() / 14);
    for i in 0..ld_bytes.len() / 14 {
        let at = i * 14;
        let va = usize::from(u16le(ld_bytes, at)?);
        let vb = usize::from(u16le(ld_bytes, at + 2)?);
        let flags = u16le(ld_bytes, at + 4)?;
        let special = u16le(ld_bytes, at + 6)?;
        let tag = u16le(ld_bytes, at + 8)?;
        let front = usize::from(u16le(ld_bytes, at + 10)?);
        let back = i32::from(i16le(ld_bytes, at + 12)?);
        ensure!(
            va < vertices.len() && vb < vertices.len(),
            "bad linedef vertex"
        );
        ensure!(
            front < sides.len() && (back == -1 || (back >= 0 && (back as usize) < sides.len())),
            "bad linedef side"
        );
        lines.push(Line {
            va,
            vb,
            a: [f32::from(vertices[va][0]), f32::from(vertices[va][1])],
            b: [f32::from(vertices[vb][0]), f32::from(vertices[vb][1])],
            flags,
            special,
            tag,
            front,
            back,
        });
    }

    let sg_bytes = records("SEGS", 12)?;
    let mut segs = Vec::with_capacity(sg_bytes.len() / 12);
    for i in 0..sg_bytes.len() / 12 {
        let at = i * 12;
        let va = usize::from(u16le(sg_bytes, at)?);
        let vb = usize::from(u16le(sg_bytes, at + 2)?);
        let line_idx = usize::from(u16le(sg_bytes, at + 6)?);
        let dir = u16le(sg_bytes, at + 8)?;
        ensure!(
            va < vertices.len() && vb < vertices.len() && line_idx < lines.len() && dir <= 1,
            "bad seg"
        );
        let side_idx = if dir == 0 {
            lines[line_idx].front as i32
        } else {
            lines[line_idx].back
        };
        ensure!(side_idx >= 0, "seg missing side");
        segs.push(Seg {
            a: [f32::from(vertices[va][0]), f32::from(vertices[va][1])],
            b: [f32::from(vertices[vb][0]), f32::from(vertices[vb][1])],
            sector: sides[side_idx as usize].sector,
        });
    }

    let ss_bytes = records("SSECTORS", 4)?;
    let mut subsectors = Vec::with_capacity(ss_bytes.len() / 4);
    for i in 0..ss_bytes.len() / 4 {
        let count = usize::from(u16le(ss_bytes, i * 4)?);
        let first = usize::from(u16le(ss_bytes, i * 4 + 2)?);
        ensure!(count > 0 && first + count <= segs.len(), "bad subsector");
        subsectors.push(Subsector {
            first,
            count,
            sector: segs[first].sector,
        });
    }

    let nd_bytes = records("NODES", 28)?;
    let mut nodes = Vec::with_capacity(nd_bytes.len() / 28);
    for i in 0..nd_bytes.len() / 28 {
        let at = i * 28;
        nodes.push(BspNode {
            ox: i16le(nd_bytes, at)?,
            oy: i16le(nd_bytes, at + 2)?,
            dx: i16le(nd_bytes, at + 4)?,
            dy: i16le(nd_bytes, at + 6)?,
            front: u16le(nd_bytes, at + 24)?,
            back: u16le(nd_bytes, at + 26)?,
        });
    }

    let bounds = [
        [-32768.0, -32768.0],
        [32768.0, -32768.0],
        [32768.0, 32768.0],
        [-32768.0, 32768.0],
    ];
    let mut floor_triangles = Vec::new();
    build_floors(
        nodes.len() - 1,
        &bounds,
        0,
        &nodes,
        &subsectors,
        &segs,
        &mut floor_triangles,
    )?;

    let th_bytes = records("THINGS", 10)?;
    let mut things = Vec::with_capacity(th_bytes.len() / 10);
    for i in 0..th_bytes.len() / 10 {
        let at = i * 10;
        things.push(Thing {
            x: i16le(th_bytes, at)?,
            y: i16le(th_bytes, at + 2)?,
            angle: i16le(th_bytes, at + 4)?,
            kind: u16le(th_bytes, at + 6)?,
            flags: u16le(th_bytes, at + 8)?,
        });
    }

    // Extract 12 DMX PCM sounds into 16-bit mono WAV buffers.
    let mut wav_clips = Vec::with_capacity(SOUND_NAMES.len());
    for name in SOUND_NAMES {
        let data = lump(name)?;
        ensure!(
            data.len() >= 8 && u16le(data, 0)? == 3,
            "expected DMX PCM sound {name}"
        );
        let rate = u32::from(u16le(data, 2)?);
        let sample_count = u32le(data, 4)? as usize;
        ensure!(
            (8_000..=192_000).contains(&rate)
                && sample_count > 32
                && 8 + sample_count <= data.len(),
            "bad DMX sound {name}"
        );
        let mut pcm16 = Vec::with_capacity(sample_count - 32);
        for j in 16..sample_count - 16 {
            let s = ((i32::from(data[8 + j]) - 128) * 256).clamp(-32768, 32767) as i16;
            pcm16.push(s);
        }
        wav_clips.push(encode_mono_pcm16_wav(rate, &pcm16));
    }

    // Discover SW1* -> SW2* switch linedefs.
    let mut line_switch_slot = vec![0u32; lines.len()];
    let mut switch_on_rects = Vec::new();
    for (line_idx, line) in lines.iter().enumerate() {
        let mut assigned: Option<u32> = None;
        for side_id in [line.front as i32, line.back] {
            if side_id < 0 {
                continue;
            }
            let side = &sides[side_id as usize];
            for tex_id in [side.upper, side.lower, side.middle] {
                if tex_id < 0 {
                    continue;
                }
                let pic = &atlas.pictures[tex_id as usize];
                if let Some(rest) = pic.name.strip_prefix("SW1") {
                    let on_name = format!("SW2{rest}");
                    if let Some(on_id) = atlas.find_picture(&on_name, 1) {
                        let on_pic = &atlas.pictures[on_id];
                        let rect = [
                            on_pic.x as f32,
                            on_pic.y as f32,
                            on_pic.w as f32,
                            on_pic.h as f32,
                        ];
                        if let Some(prev) = assigned {
                            ensure!(
                                switch_on_rects[(prev - 1) as usize] == rect,
                                "linedef {line_idx} has multiple distinct SW1 textures"
                            );
                        } else {
                            switch_on_rects.push(rect);
                            let slot1 = switch_on_rects.len() as u32;
                            line_switch_slot[line_idx] = slot1;
                            assigned = Some(slot1);
                        }
                    }
                }
            }
        }
    }
    ensure!(switch_on_rects.len() < 15, "too many switch slots");

    Ok(BakedDoom {
        atlas_rgba: atlas.pixels,
        pictures: atlas.pictures,
        sky_picture,
        vertices,
        sides,
        lines,
        sectors,
        subsectors,
        nodes,
        floor_triangles,
        things,
        wav_clips,
        line_switch_slot,
        switch_on_rects,
    })
}

impl BakedDoom {
    fn find_picture(&self, name: &str, kind: u8) -> Option<usize> {
        self.pictures
            .iter()
            .position(|p| p.kind == kind && p.name == name)
    }

    fn atlas_rect(&self, pic_id: usize) -> [f32; 4] {
        let p = &self.pictures[pic_id];
        [p.x as f32, p.y as f32, p.w as f32, p.h as f32]
    }

    fn flat_anim_code(&self, name: &str, pic_id: i32) -> u32 {
        if pic_id < 0 {
            3 // F_SKY1
        } else if name.starts_with("NUKAGE") {
            1
        } else if name.starts_with("FWATER") {
            2
        } else {
            0
        }
    }

    fn build_level_mesh_json(&self) -> Result<String> {
        let mut positions: Vec<f32> = Vec::new();
        let mut normals: Vec<f32> = Vec::new();
        let mut uvs: Vec<f32> = Vec::new();
        let mut attributes: Vec<f32> = Vec::new();
        let mut tangents: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();

        // Pack all per-vertex Doom metadata into PMSH-preserved bit-exact streams:
        // - attributes (@location(8)): (sec_a | (sec_b_plus1 << 8), flags | (sw << 2) | (anim << 8) | (kind << 10) | (is_ns << 13))
        // - tangents (@location(11)):  (rect.x + rect.y * 2048, rect.w + rect.h * 2048, offset_y, 1.0)
        let mut push_vertex = |pos: [f32; 3],
                               norm: [f32; 3],
                               uv: [f32; 2],
                               sec_a: usize,
                               sec_b_plus1: usize,
                               packed_meta: u32,
                               rect: [f32; 4],
                               offset_y: f32|
         -> u32 {
            let idx = (positions.len() / 3) as u32;
            positions.extend_from_slice(&pos);
            normals.extend_from_slice(&norm);
            uvs.extend_from_slice(&uv);
            let sec_packed = (sec_a as u32) | ((sec_b_plus1 as u32) << 8);
            attributes.extend_from_slice(&[sec_packed as f32, packed_meta as f32]);
            let pxy = rect[0] + rect[1] * 2048.0;
            let pwh = rect[2] + rect[3] * 2048.0;
            tangents.extend_from_slice(&[pxy, pwh, offset_y, 1.0]);
            idx
        };

        let sky_rect = self.atlas_rect(self.sky_picture as usize);

        // 1. Floors (kind 0, CCW viewed from +Y) and Ceilings (kind 1, CCW viewed from -Y).
        for tri in &self.floor_triangles {
            let s = &self.sectors[tri.sector];
            // Floor
            let f_rect = if s.floor_pic < 0 {
                sky_rect
            } else {
                self.atlas_rect(s.floor_pic as usize)
            };
            let f_anim = self.flat_anim_code(&s.floor_name, s.floor_pic);
            let f_meta = f_anim << 8; // kind = 0 (floor)
            let fy = f32::from(s.floor);
            let f0 = push_vertex(
                [tri.a[0], fy, -tri.a[1]],
                [0.0, 1.0, 0.0],
                [tri.a[0] / 64.0, tri.a[1] / 64.0],
                tri.sector,
                0,
                f_meta,
                f_rect,
                0.0,
            );
            let f1 = push_vertex(
                [tri.b[0], fy, -tri.b[1]],
                [0.0, 1.0, 0.0],
                [tri.b[0] / 64.0, tri.b[1] / 64.0],
                tri.sector,
                0,
                f_meta,
                f_rect,
                0.0,
            );
            let f2 = push_vertex(
                [tri.c[0], fy, -tri.c[1]],
                [0.0, 1.0, 0.0],
                [tri.c[0] / 64.0, tri.c[1] / 64.0],
                tri.sector,
                0,
                f_meta,
                f_rect,
                0.0,
            );
            indices.extend_from_slice(&[f0, f1, f2]);

            // Ceiling (reverse winding a, c, b so normal is -Y / CCW viewed from below).
            let c_rect = if s.ceiling_pic < 0 {
                sky_rect
            } else {
                self.atlas_rect(s.ceiling_pic as usize)
            };
            let c_anim = self.flat_anim_code(&s.ceiling_name, s.ceiling_pic);
            let c_meta = (c_anim << 8) | (1 << 10);
            let cy = f32::from(s.ceiling);
            let c0 = push_vertex(
                [tri.a[0], cy, -tri.a[1]],
                [0.0, -1.0, 0.0],
                [tri.a[0] / 64.0, tri.a[1] / 64.0],
                tri.sector,
                0,
                c_meta,
                c_rect,
                0.0,
            );
            let c1 = push_vertex(
                [tri.c[0], cy, -tri.c[1]],
                [0.0, -1.0, 0.0],
                [tri.c[0] / 64.0, tri.c[1] / 64.0],
                tri.sector,
                0,
                c_meta,
                c_rect,
                0.0,
            );
            let c2 = push_vertex(
                [tri.b[0], cy, -tri.b[1]],
                [0.0, -1.0, 0.0],
                [tri.b[0] / 64.0, tri.b[1] / 64.0],
                tri.sector,
                0,
                c_meta,
                c_rect,
                0.0,
            );
            indices.extend_from_slice(&[c0, c1, c2]);
        }

        // 2. Walls (kinds 2..5). Hardware backface culling keeps only the viewer-facing side.
        for (line_idx, line) in self.lines.iter().enumerate() {
            let line_sw = self.line_switch_slot[line_idx];
            for face in 0..2 {
                let side_id = if face == 0 {
                    line.front as i32
                } else {
                    line.back
                };
                if side_id < 0 {
                    continue;
                }
                let other_id = if face == 0 {
                    line.back
                } else {
                    line.front as i32
                };
                let side = &self.sides[side_id as usize];
                let s = &self.sectors[side.sector];
                let a = if face == 0 { line.a } else { line.b };
                let b = if face == 0 { line.b } else { line.a };
                let seg_len = dist2(a, b);
                if seg_len < 1e-4 {
                    continue;
                }
                let dx = b[0] - a[0];
                let dy = b[1] - a[1];
                let norm = [dy / seg_len, 0.0, dx / seg_len];
                let is_ns: u32 = if (a[0] - b[0]).abs() < 0.1 { 1 } else { 0 };
                let base_flags: u32 = (if (line.flags & 8) != 0 { 1 } else { 0 })
                    | (if (line.flags & 16) != 0 { 2 } else { 0 });

                let mut emit_wall_quad = |tex_id: i32, kind: u32, other_sec_plus1: usize| {
                    if tex_id < 0 {
                        return;
                    }
                    let pic = &self.pictures[tex_id as usize];
                    let rect = self.atlas_rect(tex_id as usize);
                    let is_sw = line_sw > 0 && pic.name.starts_with("SW1");
                    let packed_meta = base_flags
                        | (if is_sw { line_sw << 2 } else { 0 })
                        | (kind << 10)
                        | (is_ns << 13);
                    let u0 = side.offset_x / (pic.w as f32);
                    let u1 = (side.offset_x + seg_len) / (pic.w as f32);
                    let y_lo = f32::from(s.floor);
                    let y_hi = f32::from(s.ceiling);
                    let p0 = push_vertex(
                        [a[0], y_lo, -a[1]],
                        norm,
                        [u0, 0.0],
                        side.sector,
                        other_sec_plus1,
                        packed_meta,
                        rect,
                        side.offset_y,
                    );
                    let p1 = push_vertex(
                        [b[0], y_lo, -b[1]],
                        norm,
                        [u1, 0.0],
                        side.sector,
                        other_sec_plus1,
                        packed_meta,
                        rect,
                        side.offset_y,
                    );
                    let p2 = push_vertex(
                        [b[0], y_hi, -b[1]],
                        norm,
                        [u1, 1.0],
                        side.sector,
                        other_sec_plus1,
                        packed_meta,
                        rect,
                        side.offset_y,
                    );
                    let p3 = push_vertex(
                        [a[0], y_hi, -a[1]],
                        norm,
                        [u0, 1.0],
                        side.sector,
                        other_sec_plus1,
                        packed_meta,
                        rect,
                        side.offset_y,
                    );
                    indices.extend_from_slice(&[p0, p1, p2, p0, p2, p3]);
                };

                if other_id < 0 {
                    emit_wall_quad(side.middle, 2, 0);
                } else {
                    let other_sec_idx = self.sides[other_id as usize].sector;
                    let other = &self.sectors[other_sec_idx];
                    let o_p1 = other_sec_idx + 1;
                    if side.upper >= 0 && !(s.ceiling_pic < 0 && other.ceiling_pic < 0) {
                        emit_wall_quad(side.upper, 3, o_p1);
                    }
                    if side.lower >= 0 {
                        emit_wall_quad(side.lower, 4, o_p1);
                    }
                    if side.middle >= 0 {
                        emit_wall_quad(side.middle, 5, o_p1);
                    }
                }
            }
        }

        let json = serde_json::json!({
            "positions": positions,
            "normals": normals,
            "uvs": uvs,
            "attributes": attributes,
            "tangents": tangents,
            "indices": indices,
            "lods": []
        });
        Ok(json.to_string())
    }

    fn build_doom_world_wgsl(&self) -> Result<String> {
        let sky = self.atlas_rect(self.sky_picture as usize);
        let nuk: Vec<[f32; 4]> = ["NUKAGE1", "NUKAGE2", "NUKAGE3"]
            .iter()
            .map(|n| Ok(self.atlas_rect(self.find_picture(n, 2).context(*n)?)))
            .collect::<Result<_>>()?;
        let fw: Vec<[f32; 4]> = ["FWATER1", "FWATER2", "FWATER3", "FWATER4"]
            .iter()
            .map(|n| Ok(self.atlas_rect(self.find_picture(n, 2).context(*n)?)))
            .collect::<Result<_>>()?;
        let sw_rects: Vec<[f32; 4]> = if self.switch_on_rects.is_empty() {
            vec![[0.0, 0.0, 1.0, 1.0]]
        } else {
            self.switch_on_rects.clone()
        };
        let fmt_v4 =
            |r: [f32; 4]| format!("vec4f({:.1}, {:.1}, {:.1}, {:.1})", r[0], r[1], r[2], r[3]);
        let sw_entries = sw_rects
            .iter()
            .map(|&r| fmt_v4(r))
            .collect::<Vec<_>>()
            .join(", ");
        let sw_len = sw_rects.len();

        Ok(format!(
            r#"struct Scene {{
  view: mat4x4f,
  projection: mat4x4f,
  ambient: vec4f,
  light_direction: vec4f,
  light_color: vec4f,
  light_view_projection: mat4x4f,
  shadow: vec4f,
  zenith: vec4f,
  horizon: vec4f,
  ground: vec4f,
  eye: vec4f,
}};
struct Draw {{
  model: mat4x4f,
  normal: mat4x4f,
  color: vec4f,
  settings: vec4f,
  parameters: vec4f,
  extra: array<vec4f, 32>,
  surface: array<vec4f, 5>,
}};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var atlas_tex: texture_2d<f32>;
@group(1) @binding(2) var atlas_sampler: sampler;
@group(1) @binding(3) var world_field: texture_2d<f32>;

const SKY1_RECT: vec4f = {sky};
const NUKAGE_RECTS = array<vec4f, 3>({n0}, {n1}, {n2});
const FWATER_RECTS = array<vec4f, 4>({f0}, {f1}, {f2}, {f3});
const SWITCH_ON_RECTS = array<vec4f, {sw_len}>({sw_entries});

struct VsOut {{
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) rect: vec4f,
  @location(2) @interpolate(flat) light: f32,
  @location(3) dir: vec3f,
}};

fn has_field() -> bool {{
  let d = textureDimensions(world_field, 0);
  return d.x >= 256u && d.y >= 4u;
}}

fn sec_floor(s: i32) -> f32 {{
  return textureLoad(world_field, vec2i(clamp(s, 0, 255), 0), 0).r;
}}

fn sec_ceil(s: i32) -> f32 {{
  return textureLoad(world_field, vec2i(clamp(s, 0, 255), 1), 0).r;
}}

fn sec_light(s: i32) -> f32 {{
  return textureLoad(world_field, vec2i(clamp(s, 0, 255), 2), 0).r;
}}

fn sw_active(slot: i32) -> bool {{
  return textureLoad(world_field, vec2i(clamp(slot, 0, 255), 3), 0).r > 0.5;
}}

fn decode_rect(pxy: f32, pwh: f32) -> vec4f {{
  let xy = u32(max(pxy, 0.0) + 0.5);
  let wh = u32(max(pwh, 0.0) + 0.5);
  return vec4f(
    f32(xy & 2047u),
    f32((xy >> 11u) & 2047u),
    max(f32(wh & 2047u), 1.0),
    max(f32((wh >> 11u) & 2047u), 1.0),
  );
}}

@vertex fn vertex(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(8) attrs: vec2f,
  @location(11) tang: vec4f,
) -> VsOut {{
  let sec_pack = u32(max(attrs.x, 0.0) + 0.5);
  let v_flags = u32(max(attrs.y, 0.0) + 0.5);
  let sec_a = i32(sec_pack & 255u);
  let sec_b_p1 = i32((sec_pack >> 8u) & 255u);
  let sec_b = sec_b_p1 - 1;
  let upper_unpegged = (v_flags & 1u) != 0u;
  let lower_unpegged = (v_flags & 2u) != 0u;
  let sw_plus1 = i32((v_flags >> 2u) & 63u);
  let anim = (v_flags >> 8u) & 3u;
  let kind = (v_flags >> 10u) & 7u;
  let shade_mul = select(1.0, 0.88, ((v_flags >> 13u) & 1u) != 0u);
  let rect = decode_rect(tang.x, tang.y);
  let offset_y = tang.z;
  let game_time = draw.parameters.x;
  let field_ok = has_field();

  var y = position.y;
  var out_uv = uv;
  var out_rect = rect;
  var out_light = 0.7;

  let s_floor = select(position.y, sec_floor(sec_a), field_ok);
  let s_ceil = select(position.y, sec_ceil(sec_a), field_ok);
  let s_light = select(0.7, sec_light(sec_a), field_ok);

  if (kind == 0u || kind == 1u) {{
    y = select(s_ceil, s_floor, kind == 0u);
    if (anim == 3u) {{
      out_rect = SKY1_RECT;
      out_light = -1.0;
    }} else if (anim == 1u) {{
      var nuk = NUKAGE_RECTS;
      out_rect = nuk[u32(floor(max(game_time, 0.0) * 4.0)) % 3u];
      out_light = s_light;
    }} else if (anim == 2u) {{
      var fw = FWATER_RECTS;
      out_rect = fw[u32(floor(max(game_time, 0.0) * 4.0)) % 4u];
      out_light = s_light;
    }} else {{
      out_rect = rect;
      out_light = s_light;
    }}
  }} else {{
    if (sw_plus1 > 0 && field_ok && sw_active(sw_plus1 - 1)) {{
      var sw_rects = SWITCH_ON_RECTS;
      out_rect = sw_rects[clamp(sw_plus1 - 1, 0, {sw_max})];
    }}
    let pic_h = max(out_rect.w, 1.0);
    let is_top = uv.y > 0.5;
    let o_floor = select(s_floor, sec_floor(sec_b), field_ok && sec_b >= 0);
    let o_ceil = select(s_ceil, sec_ceil(sec_b), field_ok && sec_b >= 0);

    var bottom = s_floor;
    var top = s_ceil;
    var anchor = s_ceil;
    if (kind == 2u) {{
      bottom = s_floor;
      top = s_ceil;
      anchor = select(s_ceil, s_floor + pic_h, lower_unpegged);
    }} else if (kind == 3u) {{
      bottom = max(s_floor, o_ceil);
      top = s_ceil;
      anchor = select(o_ceil + pic_h, s_ceil, upper_unpegged);
    }} else if (kind == 4u) {{
      bottom = s_floor;
      top = min(s_ceil, o_floor);
      anchor = select(o_floor, s_ceil, lower_unpegged);
    }} else {{
      let span_b = max(s_floor, o_floor);
      let span_t = min(s_ceil, o_ceil);
      anchor = select(span_t, span_b + pic_h, lower_unpegged);
      bottom = max(span_b, anchor + offset_y - pic_h);
      top = min(span_t, anchor + offset_y);
    }}

    if (top <= bottom) {{
      y = bottom;
      out_uv = vec2f(uv.x, 0.0);
    }} else {{
      y = select(bottom, top, is_top);
      let v = (anchor - y + offset_y) / pic_h;
      out_uv = vec2f(uv.x, v);
    }}
    out_light = s_light * shade_mul;
  }}

  let world = vec3f(position.x, y, position.z);
  let eye = select(scene.eye.xyz, draw.extra[0].xyz, draw.extra[0].w > 0.5);
  var out: VsOut;
  out.pos = scene.projection * scene.view * vec4f(world, 1.0);
  out.uv = out_uv;
  out.rect = out_rect;
  out.light = out_light;
  out.dir = world - eye;
  return out;
}}

fn srgb_encode(light: vec3f) -> vec3f {{
  let l = max(light, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}}

@fragment fn fragment(in: VsOut) -> @location(0) vec4f {{
  var local = fract(in.uv);
  var shade = in.light;
  if (in.light < 0.0) {{
    let angle = atan2(-in.dir.z, in.dir.x);
    local.x = fract(-angle * 2.0 / 3.14159265);
    local.y = clamp(0.55 - atan2(in.dir.y, length(in.dir.xz)) * 0.8, 0.0, 0.99);
    shade = 1.0;
  }} else {{
    shade *= max(0.38, 1.0 - length(in.dir) / 1800.0);
    shade = floor((0.10 + shade * 0.90) * 24.0) / 24.0;
  }}
  let texel = in.rect.xy + clamp(floor(local * in.rect.zw), vec2f(0.0), in.rect.zw - vec2f(1.0));
  let sample_color = textureLoad(atlas_tex, vec2i(texel), 0);
  if (sample_color.a < 0.5) {{
    discard;
  }}
  return vec4f(srgb_encode(sample_color.rgb) * shade, 1.0);
}}
"#,
            sky = fmt_v4(sky),
            n0 = fmt_v4(nuk[0]),
            n1 = fmt_v4(nuk[1]),
            n2 = fmt_v4(nuk[2]),
            f0 = fmt_v4(fw[0]),
            f1 = fmt_v4(fw[1]),
            f2 = fmt_v4(fw[2]),
            f3 = fmt_v4(fw[3]),
            sw_len = sw_len,
            sw_entries = sw_entries,
            sw_max = sw_len - 1,
        ))
    }

    pub fn generate_e1m1_blot(&self) -> Result<String> {
        // Assign compact sequential picture IDs for all runtime HUD/weapon/monster/thing sprites.
        struct Interner<'a> {
            baked: &'a BakedDoom,
            map: HashMap<usize, u32>,
            list: Vec<usize>,
        }
        impl<'a> Interner<'a> {
            fn intern(&mut self, orig_id: usize) -> u32 {
                if let Some(&id) = self.map.get(&orig_id) {
                    return id;
                }
                let id = self.list.len() as u32;
                self.list.push(orig_id);
                self.map.insert(orig_id, id);
                id
            }
            fn patch(&mut self, name: &str) -> Result<u32> {
                let orig = self
                    .baked
                    .find_picture(name, 0)
                    .with_context(|| format!("missing patch {name}"))?;
                Ok(self.intern(orig))
            }
            fn frame(&mut self, prefix: &str, frame: u8) -> Result<u32> {
                let letter = (b'A' + frame) as char;
                let n0 = format!("{prefix}{letter}0");
                if let Some(id) = self.baked.find_picture(&n0, 0) {
                    return Ok(self.intern(id));
                }
                let n1 = format!("{prefix}{letter}1");
                if let Some(id) = self.baked.find_picture(&n1, 0) {
                    return Ok(self.intern(id));
                }
                bail!("missing sprite frame {prefix}{letter}");
            }
        }
        let mut intr = Interner {
            baked: self,
            map: HashMap::new(),
            list: Vec::new(),
        };

        let pic_white = intr.intern(0);
        assert_eq!(pic_white, 0);

        let mut font_pics = Vec::with_capacity(63);
        for c in 33..96u32 {
            font_pics.push(intr.patch(&format!("STCFN{c:03}"))?);
        }
        let face_pics = vec![
            intr.patch("STFST00")?,
            intr.patch("STFST10")?,
            intr.patch("STFST20")?,
            intr.patch("STFST30")?,
            intr.patch("STFST40")?,
            intr.patch("STFDEAD0")?,
        ];
        let pic_bkey = intr.patch("BKEYA0")?;
        let pic_clip = intr.patch("CLIPA0")?;
        let pic_shot = intr.patch("SHOTA0")?;

        let weap_pung = vec![intr.frame("PUNG", 0)?, intr.frame("PUNG", 1)?];
        let weap_pisg = vec![intr.frame("PISG", 0)?, intr.frame("PISG", 1)?];
        let weap_shtg = (0..4)
            .map(|f| intr.frame("SHTG", f))
            .collect::<Result<Vec<_>>>()?;
        let weap_chgg = vec![intr.frame("CHGG", 0)?, intr.frame("CHGG", 1)?];
        let flash_pisf = intr.frame("PISF", 0)?;
        let flash_shtf = intr.frame("SHTF", 0)?;
        let flash_chgf = intr.frame("CHGF", 0)?;
        let bal1_pics = vec![intr.frame("BAL1", 0)?, intr.frame("BAL1", 1)?];
        let bar1_pics = vec![intr.frame("BAR1", 0)?, intr.frame("BAR1", 1)?];
        let bexp_pics = (0..5)
            .map(|f| intr.frame("BEXP", f))
            .collect::<Result<Vec<_>>>()?;
        let poss_pics = (0..12)
            .map(|f| intr.frame("POSS", f))
            .collect::<Result<Vec<_>>>()?;
        let spos_pics = (0..12)
            .map(|f| intr.frame("SPOS", f))
            .collect::<Result<Vec<_>>>()?;
        let troo_pics = (0..13)
            .map(|f| intr.frame("TROO", f))
            .collect::<Result<Vec<_>>>()?;
        let sarg_pics = (0..14)
            .map(|f| intr.frame("SARG", f))
            .collect::<Result<Vec<_>>>()?;

        // Pack skill-2 things & player start.
        let mut start_x = 0.0_f32;
        let mut start_y = 0.0_f32;
        let mut start_yaw = 0.0_f32;
        let mut have_start = false;
        let mut thing_words: Vec<u32> = Vec::new();
        for th in &self.things {
            if th.kind == 1 {
                start_x = f32::from(th.x);
                start_y = f32::from(th.y);
                start_yaw = f32::from(th.angle) * std::f32::consts::PI / 180.0;
                have_start = true;
            }
            if (th.flags & 2) == 0 || (th.flags & 16) != 0 {
                continue;
            }
            let Some(pic_name) = thing_picture_name(th.kind) else {
                continue;
            };
            let compact_pic = intr.patch(pic_name)?;
            ensure!(compact_pic <= 65535, "too many compact pictures");
            let w0 = pack_i16_pair(th.x, th.y);
            let w1 = u32::from(th.kind) | (compact_pic << 16);
            thing_words.push(w0);
            thing_words.push(w1);
        }
        ensure!(have_start, "missing player-one start in E1M1");
        let compact_pics = intr.list;

        // Pack picture metrics (3 U32s per compact picture).
        let mut pic_words: Vec<u32> = Vec::with_capacity(compact_pics.len() * 3);
        for &orig_id in &compact_pics {
            let p = &self.pictures[orig_id];
            ensure!(
                (0..=65535).contains(&p.x)
                    && (0..=65535).contains(&p.y)
                    && (0..=65535).contains(&p.w)
                    && (0..=65535).contains(&p.h),
                "picture coords out of u16 range"
            );
            pic_words.push((p.x as u32) | ((p.y as u32) << 16));
            pic_words.push((p.w as u32) | ((p.h as u32) << 16));
            pic_words.push(pack_i16_pair(p.left as i16, p.top as i16));
        }

        // Pack vertices (1 U32 per vertex).
        let vert_words: Vec<u32> = self
            .vertices
            .iter()
            .map(|&[x, y]| pack_i16_pair(x, y))
            .collect();

        // Pack sectors (2 U32s per sector).
        let mut sector_words: Vec<u32> = Vec::with_capacity(self.sectors.len() * 2);
        for s in &self.sectors {
            ensure!(
                (0..=255).contains(&s.special) && s.tag >= 0,
                "sector special/tag out of packed range"
            );
            sector_words.push(pack_i16_pair(s.floor, s.ceiling));
            sector_words
                .push(u32::from(s.light_byte) | ((s.special as u32) << 8) | ((s.tag as u32) << 16));
        }

        // Pack linedefs (3 U32s per linedef).
        let mut line_words: Vec<u32> = Vec::with_capacity(self.lines.len() * 3);
        for (idx, line) in self.lines.iter().enumerate() {
            let front_sec = self.sides[line.front].sector;
            let back_sec_plus1 = if line.back < 0 {
                0
            } else {
                self.sides[line.back as usize].sector + 1
            };
            ensure!(
                line.special <= 255 && line.tag <= 4095 && self.line_switch_slot[idx] <= 15,
                "linedef {idx} fields out of packed range"
            );
            line_words.push((line.va as u32) | ((line.vb as u32) << 16));
            line_words.push((front_sec as u32) | ((back_sec_plus1 as u32) << 16));
            line_words.push(
                u32::from(line.flags & 0xff)
                    | (u32::from(line.special) << 8)
                    | (u32::from(line.tag) << 16)
                    | (self.line_switch_slot[idx] << 28),
            );
        }

        // Pack subsector -> sector (2 per U32).
        let mut subsector_words: Vec<u32> = Vec::with_capacity(self.subsectors.len().div_ceil(2));
        for pair in self.subsectors.chunks(2) {
            let lo = pair[0].sector as u32;
            let hi = pair.get(1).map_or(0, |s| s.sector as u32);
            subsector_words.push(lo | (hi << 16));
        }

        // Pack BSP nodes (3 U32s per node).
        let mut node_words: Vec<u32> = Vec::with_capacity(self.nodes.len() * 3);
        for n in &self.nodes {
            node_words.push(pack_i16_pair(n.ox, n.oy));
            node_words.push(pack_i16_pair(n.dx, n.dy));
            node_words.push(u32::from(n.front) | (u32::from(n.back) << 16));
        }

        let mut out = String::with_capacity(90_000);
        out.push_str("//! Generated Freedoom E1M1 map, BSP, thing, and sprite metric tables.\n");
        out.push_str(
            "//! Regenerated deterministically from `tools/assets/freedoom1-e1m1.wad`.\n\n",
        );
        out.push_str(&format!(
            "const vertex_count: U32 = {}\n",
            self.vertices.len()
        ));
        out.push_str(&format!(
            "const sector_count: U32 = {}\n",
            self.sectors.len()
        ));
        out.push_str(&format!("const line_count: U32 = {}\n", self.lines.len()));
        out.push_str(&format!(
            "const subsector_count: U32 = {}\n",
            self.subsectors.len()
        ));
        out.push_str(&format!("const node_count: U32 = {}\n", self.nodes.len()));
        out.push_str(&format!(
            "const thing_count: U32 = {}\n",
            thing_words.len() / 2
        ));
        out.push_str(&format!(
            "const switch_count: U32 = {}\n",
            self.switch_on_rects.len()
        ));
        out.push_str(&format!("const pic_count: U32 = {}\n", compact_pics.len()));
        out.push_str(&format!("const player_start_x: F32 = {start_x:.1}\n"));
        out.push_str(&format!("const player_start_y: F32 = {start_y:.1}\n"));
        out.push_str(&format!("const player_start_yaw: F32 = {start_yaw:.7}\n\n"));

        out.push_str(&format!("const pic_white: U32 = {pic_white}\n"));
        out.push_str(&format!("const pic_bkey: U32 = {pic_bkey}\n"));
        out.push_str(&format!("const pic_clip: U32 = {pic_clip}\n"));
        out.push_str(&format!("const pic_shot: U32 = {pic_shot}\n"));
        out.push_str(&format!("const flash_pisf: U32 = {flash_pisf}\n"));
        out.push_str(&format!("const flash_shtf: U32 = {flash_shtf}\n"));
        out.push_str(&format!("const flash_chgf: U32 = {flash_chgf}\n\n"));

        write_u32_array(&mut out, "font_pics", &font_pics, 12);
        write_u32_array(&mut out, "face_pics", &face_pics, 12);
        write_u32_array(&mut out, "weap_pung", &weap_pung, 12);
        write_u32_array(&mut out, "weap_pisg", &weap_pisg, 12);
        write_u32_array(&mut out, "weap_shtg", &weap_shtg, 12);
        write_u32_array(&mut out, "weap_chgg", &weap_chgg, 12);
        write_u32_array(&mut out, "bal1_pics", &bal1_pics, 12);
        write_u32_array(&mut out, "bar1_pics", &bar1_pics, 12);
        write_u32_array(&mut out, "bexp_pics", &bexp_pics, 12);
        write_u32_array(&mut out, "poss_pics", &poss_pics, 12);
        write_u32_array(&mut out, "spos_pics", &spos_pics, 12);
        write_u32_array(&mut out, "troo_pics", &troo_pics, 12);
        write_u32_array(&mut out, "sarg_pics", &sarg_pics, 12);
        write_u32_array(&mut out, "pic_words", &pic_words, 9);
        write_u32_array(&mut out, "vert_words", &vert_words, 8);
        write_u32_array(&mut out, "sector_words", &sector_words, 8);
        write_u32_array(&mut out, "line_words", &line_words, 9);
        write_u32_array(&mut out, "subsector_words", &subsector_words, 8);
        write_u32_array(&mut out, "node_words", &node_words, 9);
        write_u32_array(&mut out, "thing_words", &thing_words, 8);

        Ok(out)
    }
}

fn pack_i16_pair(a: i16, b: i16) -> u32 {
    let lo = (i32::from(a) + 32768) as u32;
    let hi = (i32::from(b) + 32768) as u32;
    (lo & 0xffff) | ((hi & 0xffff) << 16)
}

fn write_u32_array(out: &mut String, name: &str, words: &[u32], per_line: usize) {
    out.push_str(&format!("const {name}: #[U32] = #[\n"));
    for chunk in words.chunks(per_line) {
        out.push_str("  ");
        for (i, w) in chunk.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            out.push_str(&format!("{w},"));
        }
        out.push('\n');
    }
    out.push_str("]\n\n");
}

fn generate_billboard_mesh_json() -> String {
    serde_json::json!({
        "positions": [
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
            0.0, 1.0, 0.0
        ],
        "normals": [
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0
        ],
        "uvs": [
            0.0, 1.0,
            1.0, 1.0,
            1.0, 0.0,
            0.0, 0.0
        ],
        "indices": [0, 1, 2, 0, 2, 3],
        "lods": []
    })
    .to_string()
}

const DOOM_SPRITE_WGSL: &str = r#"struct Scene {
  view: mat4x4f,
  projection: mat4x4f,
  ambient: vec4f,
  light_direction: vec4f,
  light_color: vec4f,
  light_view_projection: mat4x4f,
  shadow: vec4f,
  zenith: vec4f,
  horizon: vec4f,
  ground: vec4f,
  eye: vec4f,
};
struct Draw {
  model: mat4x4f,
  normal: mat4x4f,
  color: vec4f,
  settings: vec4f,
  parameters: vec4f,
  extra: array<vec4f, 32>,
  surface: array<vec4f, 5>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var atlas_tex: texture_2d<f32>;
@group(1) @binding(2) var atlas_sampler: sampler;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) rect: vec4f,
  @location(2) @interpolate(flat) light: f32,
  @location(3) dir: vec3f,
};

fn decode_rect(pxy: f32, pwh: f32) -> vec4f {
  let xy = u32(max(pxy, 0.0) + 0.5);
  let wh = u32(max(pwh, 0.0) + 0.5);
  return vec4f(
    f32(xy & 2047u),
    f32((xy >> 11u) & 2047u),
    max(f32(wh & 2047u), 1.0),
    max(f32((wh >> 11u) & 2047u), 1.0),
  );
}

fn build_out(model: mat4x4f, position: vec3f, uv: vec2f, params: vec4f) -> Out {
  let world = (model * vec4f(position, 1.0)).xyz;
  return Out(
    scene.projection * scene.view * vec4f(world, 1.0),
    uv,
    decode_rect(params.x, params.y),
    params.z,
    world - scene.eye.xyz,
  );
}

@vertex fn vertex(@location(0) position: vec3f, @location(2) uv: vec2f) -> Out {
  return build_out(draw.model, position, uv, draw.parameters);
}

@vertex fn vertex_instanced(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(3) m0: vec4f,
  @location(4) m1: vec4f,
  @location(5) m2: vec4f,
  @location(6) m3: vec4f,
  @location(7) params: vec4f,
) -> Out {
  return build_out(mat4x4f(m0, m1, m2, m3), position, uv, params);
}

fn srgb_encode(light: vec3f) -> vec3f {
  let l = max(light, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let local = clamp(in.uv, vec2f(0.0), vec2f(0.9999));
  var shade = in.light * max(0.38, 1.0 - length(in.dir) / 1800.0);
  shade = floor((0.10 + shade * 0.90) * 24.0) / 24.0;
  let texel = in.rect.xy + clamp(floor(local * in.rect.zw), vec2f(0.0), in.rect.zw - vec2f(1.0));
  let sample_color = textureLoad(atlas_tex, vec2i(texel), 0);
  if (sample_color.a < 0.5) {
    discard;
  }
  return vec4f(srgb_encode(sample_color.rgb) * shade, 1.0);
}
"#;

const DOOM_HUD_WGSL: &str = r#"@group(0) @binding(0) var<uniform> screen: vec4f;
struct SpriteData {
  rect: vec4f,
  uv: vec4f,
  color: vec4f,
  parameters: vec4f,
};
@group(0) @binding(1) var<storage, read> sprites: array<SpriteData>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler: sampler;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) rect: vec4f,
  @location(2) color: vec4f,
  @location(3) @interpolate(flat) mode: f32,
};

@vertex fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let s = sprites[i];
  let c = corners[v];
  let mode = s.parameters.x;
  var px: vec2f;
  if (mode >= 1.5) {
    let a = s.rect.xy;
    let b = s.rect.zw;
    let d = b - a;
    let len = max(length(d), 0.1);
    let n = vec2f(-d.y, d.x) * (s.parameters.y / len);
    px = mix(a, b, c.x) + n * (c.y * 2.0 - 1.0);
  } else {
    px = s.rect.xy + c * s.rect.zw;
  }
  let ndc = vec2f(px.x / max(screen.x, 1.0) * 2.0 - 1.0, 1.0 - px.y / max(screen.y, 1.0) * 2.0);
  return Out(vec4f(ndc, 0.0, 1.0), c, s.uv, s.color, mode);
}

fn srgb_encode(light: vec3f) -> vec3f {
  let l = max(light, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  if (in.mode < 0.5 || in.mode >= 1.5) {
    return in.color;
  }
  let texel = in.rect.xy + clamp(floor(in.uv * in.rect.zw), vec2f(0.0), in.rect.zw - vec2f(1.0));
  let sample_color = textureLoad(atlas, vec2i(texel), 0);
  return vec4f(srgb_encode(sample_color.rgb) * in.color.rgb, sample_color.a * in.color.a);
}
"#;

pub fn write_mini_doom_assets(root: &Path, assets_dir: &Path) -> Result<()> {
    let baked = bake_e1m1(root)?;
    let png = crate::minecraft_assets::encode_rgba_png(
        ATLAS_W as u32,
        ATLAS_H as u32,
        &baked.atlas_rgba,
    )?;
    std::fs::write(assets_dir.join("doom_atlas.png"), png)?;
    std::fs::write(
        assets_dir.join("e1m1_level.mesh.json"),
        baked.build_level_mesh_json()?,
    )?;
    std::fs::write(
        assets_dir.join("billboard.mesh.json"),
        generate_billboard_mesh_json(),
    )?;
    std::fs::write(
        assets_dir.join("doom_world.wgsl"),
        baked.build_doom_world_wgsl()?,
    )?;
    std::fs::write(assets_dir.join("doom_sprite.wgsl"), DOOM_SPRITE_WGSL)?;
    std::fs::write(assets_dir.join("doom_hud.wgsl"), DOOM_HUD_WGSL)?;

    let mut sound_files = Vec::with_capacity(baked.wav_clips.len());
    for (i, wav) in baked.wav_clips.iter().enumerate() {
        let name = format!("snd_{i:02}.wav");
        std::fs::write(assets_dir.join(&name), wav)?;
        sound_files.push(name);
    }

    let world_mat = serde_json::json!({
        "shader": "doom_world.wgsl",
        "texture": "doom_atlas.png",
        "color": [1.0, 1.0, 1.0, 1.0],
        "lighting": "unlit",
        "shadow": false
    });
    let sprite_mat = serde_json::json!({
        "shader": "doom_sprite.wgsl",
        "texture": "doom_atlas.png",
        "color": [1.0, 1.0, 1.0, 1.0],
        "lighting": "unlit",
        "shadow": false
    });
    let hud_mat = serde_json::json!({
        "shader": "doom_hud.wgsl",
        "texture": "doom_atlas.png",
        "color": [1.0, 1.0, 1.0, 1.0],
        "lighting": "unlit",
        "blend": true
    });
    std::fs::write(
        assets_dir.join("world.material.json"),
        world_mat.to_string() + "\n",
    )?;
    std::fs::write(
        assets_dir.join("sprite.material.json"),
        sprite_mat.to_string() + "\n",
    )?;
    std::fs::write(
        assets_dir.join("hud.material.json"),
        hud_mat.to_string() + "\n",
    )?;

    let catalog = serde_json::json!({
        "meshes": ["e1m1_level.mesh.json", "billboard.mesh.json"],
        "materials": ["world.material.json", "sprite.material.json", "hud.material.json"],
        "sounds": sound_files,
    });
    std::fs::write(
        assets_dir.join("catalog.json"),
        serde_json::to_string_pretty(&catalog)? + "\n",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freedoom_e1m1_bakes_atlas_mesh_sounds_and_blot_tables() {
        let root = crate::root();
        let baked = bake_e1m1(&root).unwrap();
        assert_eq!(baked.vertices.len(), 1196);
        assert_eq!(baked.sectors.len(), 182);
        assert_eq!(baked.lines.len(), 1175);
        assert_eq!(baked.subsectors.len(), 682);
        assert_eq!(baked.nodes.len(), 681);
        assert_eq!(baked.switch_on_rects.len(), 2);
        assert!(baked.floor_triangles.len() > 1000);
        assert_eq!(baked.wav_clips.len(), 12);
        for wav in &baked.wav_clips {
            assert_eq!(&wav[0..4], b"RIFF");
            assert_eq!(&wav[8..12], b"WAVE");
        }
        let mesh_str = baked.build_level_mesh_json().unwrap();
        let mesh: serde_json::Value = serde_json::from_str(&mesh_str).unwrap();
        let pos_len = mesh["positions"].as_array().unwrap().len();
        let idx_len = mesh["indices"].as_array().unwrap().len();
        assert!(pos_len > 15_000 && pos_len % 3 == 0);
        assert!(idx_len > 15_000 && idx_len % 3 == 0);

        let blot_src = baked.generate_e1m1_blot().unwrap();
        let target = root.join("examples/mini_doom_e1m1.blot");
        if std::env::var_os("UPDATE_DOOM_E1M1").is_some() || !target.is_file() {
            std::fs::write(&target, &blot_src).unwrap();
        }
        let on_disk = std::fs::read_to_string(&target).unwrap();
        assert_eq!(
            on_disk, blot_src,
            "examples/mini_doom_e1m1.blot is out of date; re-run with UPDATE_DOOM_E1M1=1"
        );
    }

    #[test]
    fn mini_doom_blot_gameplay_suite_passes() {
        let mut fx = crate::Fixture::new("examples/mini_doom.blot");
        let out = fx.floats("test_mini_doom", ());
        assert_eq!(out, vec![1.0, 0.0], "mini_doom gameplay tests failed");
    }
}
