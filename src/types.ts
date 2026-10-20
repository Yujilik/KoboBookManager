export interface Metadata {
  title: string;
  authors: string[];
  language: string;
  publisher: string;
  description: string;
  tags: string[];
  series: string;
  seriesIndex: string;
  isbn: string;
  published: string;
}

export interface Book extends Metadata {
  id: string;
  filename: string;
  format: 'epub' | 'pdf';
  size: number;
  added: string;
  updated: string;
  cover?: string;
  customCover?: string;
  sourceUri?: string;
  sourceModified?: string;
  sourceFolder?: string;
  edited?: boolean;
}

export interface Cover { bytes: Uint8Array; mime: string }
