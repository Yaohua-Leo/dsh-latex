import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeSideBySide,
  cropImage,
  decodePng,
  diffImages,
  diffPngs,
  encodePng,
  toRgb,
} from '../src/png.js';
import { encodePng as encodeTestPng } from './png-helper.mjs';

function rgbaImage(width, height, pixels) {
  return encodeTestPng({ width, height, colorType: 6, channels: 4, rows: pixels });
}

test('decodePng reads an RGBA image', () => {
  const png = rgbaImage(2, 1, [[255, 0, 0, 255, 0, 255, 0, 255]]);
  const image = decodePng(png);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.equal(image.channels, 4);
  assert.deepEqual(Array.from(image.data), [255, 0, 0, 255, 0, 255, 0, 255]);
});

test('decodePng rejects unsupported input instead of guessing', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /signature/);
  const sixteenBit = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // A well-formed signature without IHDR is still rejected.
  assert.throws(() => decodePng(sixteenBit), /IHDR/);
});

test('diffImages reports a bounding box for changed pixels', () => {
  const before = {
    width: 3,
    height: 2,
    channels: 3,
    data: new Uint8Array(18).fill(255),
  };
  const after = {
    width: 3,
    height: 2,
    channels: 3,
    data: Uint8Array.from(before.data),
  };
  after.data[3] = 0; // pixel (1, 0), red channel
  const diff = diffImages(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.changed, 1);
  assert.deepEqual(diff.box, { x: 1, y: 0, w: 1, h: 1 });
  assert.ok(diff.ratio > 0.16 && diff.ratio < 0.17);
});

test('diffImages refuses images of different sizes', () => {
  const diff = diffImages(
    { width: 2, height: 2, channels: 3, data: new Uint8Array(12) },
    { width: 4, height: 2, channels: 3, data: new Uint8Array(24) },
  );
  assert.equal(diff.comparable, false);
  assert.equal(diff.reason, 'size-changed');
});

test('diffPngs decodes both sides', () => {
  const before = rgbaImage(1, 1, [[0, 0, 0, 255]]);
  const after = rgbaImage(1, 1, [[255, 255, 255, 255]]);
  const diff = diffPngs(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.changed, 1);
  assert.equal(diff.ratio, 1);
});

function solid(width, height, color) {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = color[0];
    data[i * 3 + 1] = color[1];
    data[i * 3 + 2] = color[2];
  }
  return { width, height, channels: 3, data };
}

test('encodePng round-trips RGB samples', () => {
  const original = solid(4, 3, [10, 20, 30]);
  const decoded = decodePng(encodePng(original));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.channels, 3);
  assert.deepEqual(Array.from(decoded.data), Array.from(original.data));
});

test('cropImage and toRgb normalize channels', () => {
  const image = { width: 3, height: 2, channels: 6, data: new Uint8Array(36) };
  // Not a real channel count: composition helpers must reject this path.
  assert.throws(() => toRgb(image), /cannot convert/);
  const cropped = cropImage(solid(5, 4, [1, 2, 3]), { x: 1, y: 1, w: 2, h: 2 });
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.deepEqual(Array.from(cropped.data.slice(0, 3)), [1, 2, 3]);
});

test('composeSideBySide crops both sides, pads the gutter and draws a red box', () => {
  const before = solid(100, 100, [90, 90, 90]);
  const after = solid(100, 100, [200, 200, 200]);
  const composed = composeSideBySide(before, after, {
    box: { x: 40, y: 40, w: 10, h: 10 },
    margin: 5,
    gutter: 4,
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.width, 20 * 2 + 4);
  assert.equal(composed.height, 20);
  const decoded = decodePng(encodePng(composed));
  assert.equal(decoded.width, composed.width);
  // The gutter is white.
  const gutterX = 20 + 1;
  const gutterOffset = (gutterX + 5 * composed.width) * 3;
  assert.deepEqual(Array.from(decoded.data.slice(gutterOffset, gutterOffset + 3)), [255, 255, 255]);
  // The red box starts at crop-relative (5,5) on both sides.
  const leftBox = (5 * composed.width + 5) * 3;
  const rightBox = (5 * composed.width + 20 + 4 + 5) * 3;
  assert.ok(decoded.data[leftBox] > 200 && decoded.data[leftBox + 1] < 60, 'left box is red');
  assert.ok(decoded.data[rightBox] > 200 && decoded.data[rightBox + 1] < 60, 'right box is red');
});

test('composeSideBySide supports an added page with a blank left side', () => {
  const after = solid(60, 60, [120, 130, 140]);
  const composed = composeSideBySide(null, after, {
    box: { x: 20, y: 20, w: 8, h: 8 },
    margin: 4,
    gutter: 6,
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.width, 16 * 2 + 6);
  const decoded = decodePng(encodePng(composed));
  const leftPixel = (0 * composed.width + 2) * 3;
  assert.deepEqual(Array.from(decoded.data.slice(leftPixel, leftPixel + 3)), [255, 255, 255]);
});

test('composeSideBySide refuses pages of different sizes', () => {
  const result = composeSideBySide(solid(10, 10, [0, 0, 0]), solid(20, 10, [0, 0, 0]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'size-changed');
});

test('composeSideBySide can pad a page-size change when explicitly allowed', () => {
  const before = solid(10, 10, [0, 0, 0]);
  before.data = new Uint8Array(before.data);
  const result = composeSideBySide(before, solid(20, 10, [255, 0, 0]), {
    allowSizeChange: true,
    gutter: 0,
    margin: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.height, 10);
  assert.equal(result.width, 50);
  // The smaller left page is padded with white on the right, then placed on
  // the left half; the red right page occupies the right half.
  assert.deepEqual([...result.data.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...result.data.subarray(19 * 3, 20 * 3)], [255, 255, 255]);
  assert.deepEqual([...result.data.subarray(30 * 3, 31 * 3)], [255, 0, 0]);
});
