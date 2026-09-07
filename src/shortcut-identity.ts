/** Match the backend's supported, unambiguous native identity formats. */
export function supportsDirectShortcut(itemId: string): boolean {
  if (itemId.length > 512 || /[\u0000-\u001f\u007f]/.test(itemId)) return false;
  return /^v1\.item-identifier\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(itemId)
    || /^v1\.item-label-role\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(itemId);
}
