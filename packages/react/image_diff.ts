/** Pixel differences for scenario captures; RGB error ignores alpha. */
export async function compareImages(
  actual: string,
  golden: string,
): Promise<{ error: number; diff: string }> {
  const pixels = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not read golden image: ${url}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
  };
  const [a, b] = await Promise.all([pixels(actual), pixels(golden)]);
  if (a.width !== b.width || a.height !== b.height) {
    return { error: 255, diff: actual };
  }
  const diff = new ImageData(a.width, a.height);
  let total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(a.data[i + c] - b.data[i + c]);
      total += delta;
      diff.data[i + c] = Math.min(255, delta * 4);
    }
    diff.data[i + 3] = 255;
  }
  const canvas = new OffscreenCanvas(a.width, a.height);
  canvas.getContext("2d")!.putImageData(diff, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  const base64 = btoa(binary);
  return {
    error: total / (a.width * a.height * 3),
    diff: `data:image/png;base64,${base64}`,
  };
}
