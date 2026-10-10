interface ElectronUpdaterMetadataInput {
  platform: string;
  extension: string;
}

export function shouldIncludeInElectronUpdaterMetadata({
  platform,
  extension,
}: ElectronUpdaterMetadataInput): boolean {
  if (platform === 'win32') {
    return extension === '.exe';
  }

  if (platform === 'linux') {
    return extension === '.AppImage';
  }

  return extension !== '.msi';
}
