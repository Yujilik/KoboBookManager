import { Capacitor, registerPlugin } from '@capacitor/core';

export interface Folder { uri: string; name: string }
export interface FolderFile { uri: string; name: string; size: number; modified: string }
export interface Delivery { urls: string[]; code: string; port: number }
interface KoboNative {
  chooseFolder(): Promise<Folder>;
  scanFolder(options: { uri: string }): Promise<{ files: FolderFile[] }>;
  readDocument(options: { uri: string }): Promise<{ data: string }>;
  saveDocument(options: { name: string; mime: string; data: string }): Promise<{ uri: string }>;
  startDelivery(options: { path?: string; name?: string; mime?: string; files?: { path: string; name: string; mime: string; title: string }[]; locale?: string; labels?: Record<string, string> }): Promise<Delivery>;
  stopDelivery(): Promise<void>;
}
export const native = registerPlugin<KoboNative>('KoboNative');
export const isAndroid = Capacitor.getPlatform() === 'android';
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export function fromBase64(base64: string) { return Uint8Array.from(atob(base64.split(',').pop()!), x => x.charCodeAt(0)); }
export function dataURL(bytes: Uint8Array, mime: string) { return 'data:' + mime + ';base64,' + toBase64(bytes); }
