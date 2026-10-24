//! Real offscreen pixels from all five standalone WGSL shaders.
use crate::*;
use wgpu::util::DeviceExt;
use wgpu::*;
const ID: [f32; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
const POS: [f32; 9] = [-1., -1., 0., 3., -1., 0., -1., 3., 0.];
struct Gpu {
    device: Device,
    queue: Queue,
}
impl Gpu {
    fn buffer(&self, v: &[f32], usage: BufferUsages) -> Buffer {
        self.device.create_buffer_init(&util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(v),
            usage: usage | BufferUsages::COPY_DST,
        })
    }
    fn uniform(&self, v: &[f32]) -> Buffer {
        self.buffer(v, BufferUsages::UNIFORM)
    }
    fn texture(&self, format: TextureFormat, size: u32) -> Texture {
        self.device.create_texture(&TextureDescriptor {
            label: None,
            size: Extent3d {
                width: size,
                height: size,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format,
            usage: TextureUsages::RENDER_ATTACHMENT
                | TextureUsages::COPY_SRC
                | TextureUsages::COPY_DST
                | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }
    fn pipeline(
        &self,
        name: &str,
        widths: &[u32],
        format: TextureFormat,
        constants: &[(&str, f64)],
    ) -> RenderPipeline {
        let source = std::fs::read_to_string(root().join(format!("shaders/{name}.wgsl"))).unwrap();
        let module = self.device.create_shader_module(ShaderModuleDescriptor {
            label: Some(name),
            source: ShaderSource::Wgsl(source.into()),
        });
        let mut offset = 0;
        let attributes = widths
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let a = VertexAttribute {
                    shader_location: i as u32,
                    offset,
                    format: match w {
                        2 => VertexFormat::Float32x2,
                        3 => VertexFormat::Float32x3,
                        4 => VertexFormat::Float32x4,
                        _ => panic!("width"),
                    },
                };
                offset += *w as u64 * 4;
                a
            })
            .collect::<Vec<_>>();
        let buffers = if widths.is_empty() {
            vec![]
        } else {
            vec![Some(VertexBufferLayout {
                array_stride: offset,
                step_mode: VertexStepMode::Vertex,
                attributes: &attributes,
            })]
        };
        let targets = [Some(ColorTargetState {
            format,
            blend: None,
            write_mask: ColorWrites::ALL,
        })];
        let fragment = (name != "shadow").then_some(FragmentState {
            module: &module,
            entry_point: Some("fragment"),
            compilation_options: PipelineCompilationOptions {
                constants,
                ..Default::default()
            },
            targets: &targets,
        });
        self.device
            .create_render_pipeline(&RenderPipelineDescriptor {
                label: Some(name),
                layout: None,
                vertex: VertexState {
                    module: &module,
                    entry_point: Some("vertex"),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive: PrimitiveState {
                    topology: if name == "debug" {
                        PrimitiveTopology::LineList
                    } else {
                        PrimitiveTopology::TriangleList
                    },
                    ..Default::default()
                },
                depth_stencil: (name == "shadow").then_some(DepthStencilState {
                    format: TextureFormat::Depth32Float,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(CompareFunction::Always),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                fragment,
                multiview_mask: None,
                cache: None,
            })
    }
    fn group(
        &self,
        p: &RenderPipeline,
        index: u32,
        resources: &[BindingResource<'_>],
    ) -> BindGroup {
        let entries = resources
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, resource)| BindGroupEntry {
                binding: i as u32,
                resource,
            })
            .collect::<Vec<_>>();
        self.device.create_bind_group(&BindGroupDescriptor {
            label: None,
            layout: &p.get_bind_group_layout(index),
            entries: &entries,
        })
    }
    fn vertices(&self, extra: &[f32]) -> Buffer {
        let v = POS
            .chunks(3)
            .flat_map(|p| p.iter().chain(extra))
            .copied()
            .collect::<Vec<_>>();
        self.buffer(&v, BufferUsages::VERTEX)
    }
    fn render(
        &self,
        p: &RenderPipeline,
        groups: &[BindGroup],
        target: &Texture,
        vertices: Option<&Buffer>,
        depth: bool,
        count: u32,
    ) -> Vec<u8> {
        let read = self.device.create_buffer(&BufferDescriptor {
            label: None,
            size: 256 * target.height() as u64,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let view = target.create_view(&Default::default());
        let colors = [Some(RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: Operations {
                load: LoadOp::Clear(Color {
                    r: 0.1,
                    g: 0.2,
                    b: 0.3,
                    a: 0.4,
                }),
                store: StoreOp::Store,
            },
        })];
        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: if depth { &[] } else { &colors },
                depth_stencil_attachment: depth.then_some(RenderPassDepthStencilAttachment {
                    view: &view,
                    depth_ops: Some(Operations {
                        load: LoadOp::Clear(1.),
                        store: StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_pipeline(p);
            for (i, g) in groups.iter().enumerate() {
                pass.set_bind_group(i as u32, g, &[]);
            }
            if let Some(v) = vertices {
                pass.set_vertex_buffer(0, v.slice(..));
            }
            pass.draw(0..count, 0..1);
        }
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &read,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: None,
                },
            },
            target.size(),
        );
        self.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        read.slice(..).map_async(MapMode::Read, move |r| {
            tx.send(r).unwrap();
        });
        self.device.poll(PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().unwrap();
        let bytes = read.slice(..).get_mapped_range().unwrap().to_vec();
        read.unmap();
        bytes
    }
}
#[test]
fn gpu_shaders_validate_and_match_independent_pixel_witnesses() {
    let instance = Instance::new(InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default()))
        .expect("Ink shader tests require a GPU adapter; install Mesa Vulkan for headless CI");
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let g = Gpu { device, queue };
    let sampler = g.device.create_sampler(&SamplerDescriptor {
        mag_filter: FilterMode::Nearest,
        min_filter: FilterMode::Nearest,
        ..Default::default()
    });
    let display = g.pipeline("display", &[], TextureFormat::Rgba8Unorm, &[]);
    let linear = g.pipeline(
        "display",
        &[],
        TextureFormat::Rgba8UnormSrgb,
        &[("encodeSRGB", 0.)],
    );
    let source = g.texture(TextureFormat::Rgba16Float, 2);
    let half: [u16; 16] = [
        0x211f, 0x3266, 0x4000, 0x3c00, 0xbc00, 0x7bff, 0, 0x3c00, 0x3666, 0x38cd, 0x3a66, 0x3c00,
        0x3c00, 0x3c00, 0x3c00, 0x3c00,
    ];
    g.queue.write_texture(
        source.as_image_copy(),
        bytemuck::cast_slice(&half),
        TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(16),
            rows_per_image: None,
        },
        source.size(),
    );
    let source_view = source.create_view(&Default::default());
    let mut witnessed = 0;
    let mut close = |a: f64, b: f64| {
        near(a, b, 2. / 255.);
        witnessed += 1;
    };
    for exposure in [0f64, 2., -20., 20.] {
        for (p, format) in [
            (&display, TextureFormat::Rgba8Unorm),
            (&linear, TextureFormat::Rgba8UnormSrgb),
        ] {
            let u = g.uniform(&[exposure as f32, 0., 0., 0.]);
            let group = g.group(
                p,
                0,
                &[
                    u.as_entire_binding(),
                    BindingResource::TextureView(&source_view),
                    BindingResource::Sampler(&sampler),
                ],
            );
            let bytes = g.render(p, &[group], &g.texture(format, 2), None, false, 3);
            let values = [0.01f64, 0.2, 2., -1., 65504., 0., 0.4, 0.6, 0.8, 1., 1., 1.];
            for pixel in 0..4 {
                for ch in 0..3 {
                    let x = values[pixel * 3 + ch].max(0.) * 2f64.powf(exposure.clamp(-16., 16.));
                    close(
                        bytes[pixel / 2 * 256 + pixel % 2 * 4 + ch] as f64 / 255.,
                        crate::render_math::srgb(crate::render_math::tone(x)),
                    );
                }
            }
        }
    }
    let camera = g.uniform(&ID);
    let debug = g.pipeline("debug", &[3, 4], TextureFormat::Rgba8Unorm, &[]);
    let bytes = g.render(
        &debug,
        &[g.group(&debug, 0, &[camera.as_entire_binding()])],
        &g.texture(TextureFormat::Rgba8Unorm, 1),
        Some(&g.buffer(
            &[
                -1., 0., 0., 0.2, 0.4, 0.6, 0.8, 1., 0., 0., 0.2, 0.4, 0.6, 0.8,
            ],
            BufferUsages::VERTEX,
        )),
        false,
        2,
    );
    for (i, v) in [0.2, 0.4, 0.6, 0.8].into_iter().enumerate() {
        close(bytes[i] as f64 / 255., v);
    }
    let sprite = g.pipeline("sprite", &[3, 2, 4], TextureFormat::Rgba8Unorm, &[]);
    let atlas = g.texture(TextureFormat::Rgba8Unorm, 1);
    g.queue.write_texture(
        atlas.as_image_copy(),
        &[128, 64, 255, 128],
        Default::default(),
        atlas.size(),
    );
    let atlas_view = atlas.create_view(&Default::default());
    for alpha in [0.5f64, 0.] {
        let group = g.group(
            &sprite,
            0,
            &[
                camera.as_entire_binding(),
                BindingResource::TextureView(&atlas_view),
                BindingResource::Sampler(&sampler),
            ],
        );
        let bytes = g.render(
            &sprite,
            &[group],
            &g.texture(TextureFormat::Rgba8Unorm, 1),
            Some(&g.vertices(&[0.5, 0.5, 0.5, 1., 0.25, alpha as f32])),
            false,
            3,
        );
        let expected = if alpha == 0. {
            [0.1, 0.2, 0.3, 0.4]
        } else {
            [128. / 255. * 0.5, 64. / 255., 0.25, 128. / 255. * alpha]
        };
        for (i, v) in expected.into_iter().enumerate() {
            close(bytes[i] as f64 / 255., v);
        }
    }
    let shadow = g.pipeline("shadow", &[3], TextureFormat::Depth32Float, &[]);
    let mut model = ID;
    model[14] = 0.37;
    let object = g.uniform(&model);
    let bytes = g.render(
        &shadow,
        &[
            g.group(&shadow, 0, &[camera.as_entire_binding()]),
            g.group(&shadow, 1, &[object.as_entire_binding()]),
        ],
        &g.texture(TextureFormat::Depth32Float, 1),
        Some(&g.buffer(&POS, BufferUsages::VERTEX)),
        true,
        3,
    );
    near(
        f32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64,
        0.37,
        1e-6,
    );
    let mesh = g.pipeline("mesh", &[3, 3], TextureFormat::Rgba8Unorm, &[]);
    for (metal, rough) in [(0f64, 0.7f64), (1., 0.04)] {
        let radiance = if rough == 0.04 { 0.00001 } else { 1. };
        let frame = g.uniform(
            &[
                ID.to_vec(),
                vec![
                    0.,
                    0.,
                    10.,
                    0.,
                    0.,
                    0.,
                    -1.,
                    0.,
                    radiance as f32,
                    radiance as f32,
                    radiance as f32,
                    0.,
                ],
            ]
            .concat(),
        );
        let base = [0.2, 0.4, 0.6];
        let emission = [0.1, 0.05, 0.02];
        let object = g.uniform(
            &[
                ID.to_vec(),
                ID.to_vec(),
                vec![
                    0.2,
                    0.4,
                    0.6,
                    0.8,
                    metal as f32,
                    rough as f32,
                    0.,
                    0.,
                    0.1,
                    0.05,
                    0.02,
                    0.,
                ],
            ]
            .concat(),
        );
        let bytes = g.render(
            &mesh,
            &[
                g.group(&mesh, 0, &[frame.as_entire_binding()]),
                g.group(&mesh, 1, &[object.as_entire_binding()]),
            ],
            &g.texture(TextureFormat::Rgba8Unorm, 1),
            Some(&g.vertices(&[0., 0., 1.])),
            false,
            3,
        );
        for (i, b) in base.into_iter().enumerate() {
            let fresnel = 0.04 * (1. - metal) + b * metal;
            let diffuse = b * (1. - fresnel) * (1. - metal) / std::f64::consts::PI;
            let spec = fresnel / (4. * std::f64::consts::PI * rough.powi(4));
            close(
                bytes[i] as f64 / 255.,
                ((diffuse + spec) * radiance + emission[i]).min(1.),
            );
        }
        close(bytes[3] as f64 / 255., 0.8);
    }
    assert_eq!(witnessed, 116);
    g.device.destroy();
}
