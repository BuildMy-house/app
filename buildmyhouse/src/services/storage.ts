/** Storage seam: the app never touches fs APIs directly, only this interface. */
export interface StorageAdapter {
  readText(path: string): Promise<string>
  writeText(path: string, contents: string): Promise<void>
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageUnavailableError'
  }
}
