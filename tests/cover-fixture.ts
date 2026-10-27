import { createCanvas } from '@napi-rs/canvas';
import type { Cover } from '../src/types';

export function coverFixture(mime = 'image/png'): Cover {
  const canvas = createCanvas(120, 180);
  const context = canvas.getContext('2d');
  context.fillStyle = '#147d92'; context.fillRect(0, 0, 120, 180);
  context.fillStyle = '#f2be55'; context.fillRect(12, 16, 96, 8);
  context.fillStyle = '#ffffff'; context.font = 'bold 14px sans-serif';
  context.fillText('NEW COVER', 15, 60);
  return { bytes: new Uint8Array(mime === 'image/png' ? canvas.encodeSync('png') : canvas.encodeSync('jpeg')), mime };
}

export function coverDataURL(cover = coverFixture()) {
  return `data:${cover.mime};base64,${Buffer.from(cover.bytes).toString('base64')}`;
}
