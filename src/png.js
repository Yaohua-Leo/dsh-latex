/**
 * A deliberately small PNG decoder used by the page-diff path.
 *
 * The plugin must not drag an image library into the Host process, and the only
 * producers of these files are `pdftoppm` and Ghostscript, which emit plain
 * 8-bit, non-interlaced RGB/RGBA PNGs. Supporting that subset (plus grayscale
 * and palette images, which are cheap to add) keeps the diff feature honest:
 * an unsupported PNG is reported as "not comparable", never guessed at.
 *
 * Supported: bit depth 8, color types 0/2/3/4/6, interlace 0, filters 0-4.
 * Not supported: 16-bit samples, Adam7 interlacing, and ancillary chunks that
 * affect pixel interpretation beyond PLTE/tRNS (tRNS is ignored).
 */
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message) {
  const error = new Error(`PNG: ${message}`);
  error.code = 'PNG_UNSUPPORTED';
  return error;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode one PNG into 8-bit samples.
 * @param {Buffer} buffer complete file bytes
 * @returns {{ width: number, height: number, channels: number, data: Uint8Array, colorType: number }}
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw fail('missing PNG signature');
  }
  let offset = 8;
  let header;
  const idat = [];
  let palette;
  const warnings = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw fail(`truncated ${type} chunk`);
    const data = buffer.subarray(start, end);
    if (type === 'IHDR') {
      if (length < 13) throw fail('short IHDR');
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'tRNS') {
      warnings.push('tRNS ignored');
    }
    offset = end + 4; // length + type + data + CRC
  }
  if (!header) throw fail('missing IHDR');
  const { width, height, bitDepth, colorType, compression, filter, interlace } = header;
  if (width === 0 || height === 0 || width > 100_000 || height > 100_000) throw fail('invalid dimensions');
  if (bitDepth !== 8) throw fail(`unsupported bit depth ${bitDepth}`);
  if (compression !== 0) throw fail('unsupported compression method');
  if (filter !== 0) throw fail('unsupported filter method');
  if (interlace !== 0) throw fail('interlaced PNG is not supported');
  const channelCount = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channelCount) throw fail(`unsupported color type ${colorType}`);
  if (colorType === 3 && !palette) throw fail('palette image without PLTE');
  if (idat.length === 0) throw fail('missing IDAT');

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 512 * 1024 * 1024 });
  } catch (error) {
    throw fail(`inflate failed: ${error.message}`);
  }

  const bpp = Math.max(1, Math.ceil((channelCount * 8) / 8));
  const stride = Math.ceil((width * channelCount * 8) / 8);
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw fail(`truncated image data (${raw.length} < ${expected})`);

  // Unfilter into a tightly packed scanline buffer (still channelCount samples per pixel).
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const target = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? target[x - bpp] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= bpp ? previous[x - bpp] : 0;
      let value = source[x];
      switch (filterType) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += Math.floor((left + up) / 2);
          break;
        case 4:
          value += paeth(left, up, upLeft);
          break;
        default:
          throw fail(`unknown filter type ${filterType} on row ${y}`);
      }
      target[x] = value & 0xff;
    }
  }

  if (colorType === 3) {
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      const index = pixels[i];
      const base = index * 3;
      if (base + 2 >= palette.length) throw fail('palette index out of range');
      rgb[i * 3] = palette[base];
      rgb[i * 3 + 1] = palette[base + 1];
      rgb[i * 3 + 2] = palette[base + 2];
    }
    return { width, height, channels: 3, data: new Uint8Array(rgb), colorType: 3, warnings };
  }
  const channels = colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
  return { width, height, channels, data: new Uint8Array(pixels), colorType, warnings };
}

/**
 * Compare two decoded images pixel by pixel.
 *
 * The diff is intentionally cheap and orientation-preserving: it answers
 * "did this page change, how much, and where", not "what changed". A size
 * change (different dpi or crop) is reported as not comparable instead of
 * pretending every pixel changed.
 *
 * @param {{ width: number, height: number, channels: number, data: Uint8Array }} before
 * @param {{ width: number, height: number, channels: number, data: Uint8Array }} after
 * @param {{ threshold?: number }} [options]
 */
export function diffImages(before, after, options = {}) {
  if (!before || !after) return { comparable: false, reason: 'missing image' };
  if (before.width !== after.width || before.height !== after.height) {
    return {
      comparable: false,
      reason: 'size-changed',
      before: { width: before.width, height: before.height },
      after: { width: after.width, height: after.height },
    };
  }
  const threshold = Number.isFinite(options.threshold) ? Math.max(0, Math.min(255, options.threshold)) : 24;
  const { width, height } = before;
  const channels = Math.min(before.channels, after.channels);
  // Ignore an alpha-only difference: PDF page renders are opaque.
  const colorChannels = channels >= 3 ? 3 : 1;
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const pixel = (row + x) * channels;
      let delta = 0;
      for (let c = 0; c < colorChannels; c += 1) {
        const a = before.data[pixel + c] ?? 0;
        const b = after.data[pixel + c] ?? 0;
        const d = a > b ? a - b : b - a;
        if (d > delta) delta = d;
      }
      if (delta > threshold) {
        changed += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = width * height;
  return {
    comparable: true,
    width,
    height,
    changed,
    ratio: total > 0 ? changed / total : 0,
    box: changed > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  };
}

/** Decode and diff two PNG buffers; never throws for unsupported files. */
export function diffPngs(beforeBuffer, afterBuffer, options = {}) {
  let before;
  let after;
  try {
    before = decodePng(beforeBuffer);
    after = decodePng(afterBuffer);
  } catch (error) {
    return { comparable: false, reason: error.message };
  }
  const maxPixels = Number(options.maxPixels) || 0;
  if (maxPixels > 0 && before.width * before.height > maxPixels) {
    return { comparable: false, reason: `image too large to diff (${before.width}x${before.height})` };
  }
  return diffImages(before, after, options);
}

/* ── Encoding, cropping and side-by-side composition (audit) ───────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode 8-bit RGB/RGBA samples as a non-interlaced PNG (filter 0).
 * @param {{ width: number, height: number, channels: number, data: Uint8Array }} image
 */
export function encodePng(image) {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG: invalid dimensions');
  }
  const channels = image.channels === 4 ? 4 : 3;
  const expected = width * height * channels;
  if (!image.data || image.data.length < expected) {
    throw new Error(`PNG: sample buffer is too short (${image.data?.length ?? 0} < ${expected})`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (rowBytes + 1);
    raw[target] = 0;
    Buffer.from(image.data.buffer ?? image.data, image.data.byteOffset ?? 0, image.data.byteLength ?? expected)
      .subarray(y * rowBytes, (y + 1) * rowBytes)
      .copy(raw, target + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Convert one decoded image to tightly packed RGB (alpha dropped). */
export function toRgb(image) {
  if (image.channels === 3) return image;
  const { width, height, data } = image;
  const rgb = Buffer.alloc(width * height * 3);
  if (image.channels === 1) {
    for (let i = 0; i < width * height; i += 1) {
      rgb[i * 3] = data[i];
      rgb[i * 3 + 1] = data[i];
      rgb[i * 3 + 2] = data[i];
    }
  } else if (image.channels === 4) {
    for (let i = 0; i < width * height; i += 1) {
      rgb[i * 3] = data[i * 4];
      rgb[i * 3 + 1] = data[i * 4 + 1];
      rgb[i * 3 + 2] = data[i * 4 + 2];
    }
  } else if (image.channels === 2) {
    for (let i = 0; i < width * height; i += 1) {
      const value = data[i * 2];
      rgb[i * 3] = value;
      rgb[i * 3 + 1] = value;
      rgb[i * 3 + 2] = value;
    }
  } else {
    throw new Error(`PNG: cannot convert ${image.channels} channels to RGB`);
  }
  return { width, height, channels: 3, data: rgb };
}

function clampRect(rect, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  const w = Math.max(1, Math.min(width - x, Math.round(rect.w)));
  const h = Math.max(1, Math.min(height - y, Math.round(rect.h)));
  return { x, y, w, h };
}

/** Crop a decoded image to a pixel rectangle. */
export function cropImage(image, rect) {
  const source = toRgb(image);
  const area = clampRect(rect, source.width, source.height);
  const data = Buffer.alloc(area.w * area.h * 3);
  for (let y = 0; y < area.h; y += 1) {
    const from = ((area.y + y) * source.width + area.x) * 3;
    source.data.subarray(from, from + area.w * 3).forEach((byte, index) => {
      data[y * area.w * 3 + index] = byte;
    });
  }
  return { width: area.w, height: area.h, channels: 3, data };
}

/** Draw a filled rectangle (used for the red change box). */
export function drawRect(image, rect, color = [220, 38, 38], thickness = 2) {
  const { width, height, data } = image;
  const area = clampRect(rect, width, height);
  const t = Math.max(1, Math.round(thickness));
  for (let y = area.y; y < area.y + area.h; y += 1) {
    for (let x = area.x; x < area.x + area.w; x += 1) {
      const edge = x < area.x + t || x >= area.x + area.w - t || y < area.y + t || y >= area.y + area.h - t;
      if (!edge) continue;
      const offset = (y * width + x) * 3;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
    }
  }
  return image;
}

/**
 * Compose a cropped "before | after" image around a changed region.
 *
 * The crop keeps both sides aligned, so a reader can compare the same area.
 * A red rectangle marks the diff box on both sides. `before` may be null for a
 * newly added page (the left side is left white).
 *
 * @param {object|null} before decoded image
 * @param {object} after decoded image
 * @param {{ box?: {x:number,y:number,w:number,h:number}, margin?: number, gutter?: number }} [options]
 * @returns {{ width:number, height:number, channels:3, data:Buffer, crop:object, box:object|null }}
 */
/** Pad an RGB image with a white background to an exact canvas size. */
export function padImage(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < image.height; y += 1) {
    const from = y * image.width * 3;
    const to = y * width * 3;
    data.set(image.data.subarray(from, from + image.width * 3), to);
  }
  return { width, height, channels: 3, data };
}

export function composeSideBySide(before, after, options = {}) {
  const rightSource = toRgb(after);
  const leftSource = before ? toRgb(before) : undefined;
  if (
    leftSource &&
    !options.allowSizeChange &&
    (leftSource.width !== rightSource.width || leftSource.height !== rightSource.height)
  ) {
    return {
      ok: false,
      reason: 'size-changed',
      before: { width: leftSource.width, height: leftSource.height },
      after: { width: rightSource.width, height: rightSource.height },
    };
  }
  const canvasWidth = Math.max(leftSource?.width ?? 0, rightSource.width);
  const canvasHeight = Math.max(leftSource?.height ?? 0, rightSource.height);
  const left = leftSource ? padImage(leftSource, canvasWidth, canvasHeight) : undefined;
  const right = padImage(rightSource, canvasWidth, canvasHeight);
  const margin = Math.max(0, Math.min(200, Number(options.margin) || 20));
  const gutter = Math.max(0, Math.min(100, Number(options.gutter) || 10));
  const box = options.box ? clampRect(options.box, right.width, right.height) : undefined;
  const crop = box
    ? clampRect(
        {
          x: box.x - margin,
          y: box.y - margin,
          w: box.w + margin * 2,
          h: box.h + margin * 2,
        },
        right.width,
        right.height,
      )
    : { x: 0, y: 0, w: right.width, h: right.height };
  const leftCrop = left ? cropImage(left, crop) : undefined;
  const rightCrop = cropImage(right, crop);
  const height = Math.max(leftCrop?.height ?? 0, rightCrop.height);
  const width = crop.w * 2 + gutter;
  const data = Buffer.alloc(width * height * 3, 255);
  const put = (cropImageSource, offsetX) => {
    if (!cropImageSource) return;
    for (let y = 0; y < cropImageSource.height; y += 1) {
      const from = y * cropImageSource.width * 3;
      const to = (y * width + offsetX) * 3;
      cropImageSource.data.subarray(from, from + cropImageSource.width * 3).forEach((byte, index) => {
        data[to + index] = byte;
      });
    }
  };
  put(leftCrop, 0);
  put(rightCrop, crop.w + gutter);
  const composed = { width, height, channels: 3, data };
  if (box) {
    const localBox = {
      x: Math.max(0, box.x - crop.x),
      y: Math.max(0, box.y - crop.y),
      w: Math.max(1, Math.min(crop.w, box.w)),
      h: Math.max(1, Math.min(crop.h, box.h)),
    };
    if (leftCrop) drawRect(composed, localBox);
    drawRect(composed, { ...localBox, x: localBox.x + crop.w + gutter });
  }
  return {
    ok: true,
    width,
    height,
    channels: 3,
    data,
    crop,
    box: box ?? null,
  };
}

