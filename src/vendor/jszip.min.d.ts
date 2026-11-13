interface ZipStream {
  on(event: 'data', handler: (data: Uint8Array) => void): ZipStream;
  on(event: 'error', handler: (error: Error) => void): ZipStream;
  on(event: 'end', handler: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}
interface ZipFile {
  internalStream(type: 'uint8array'): ZipStream;
}
export default class JSZip {
  static loadAsync(bytes: ArrayBuffer): Promise<JSZip>;
  file(name: string): ZipFile | null;
  file(name: string, data: string): this;
  generateAsync(options: { type: 'blob'; compression?: 'DEFLATE'; mimeType?: string }): Promise<Blob>;
}
