export async function persistRawThenCanonical(params: {
  persistRaw: () => Promise<void>;
  persistCanonical: () => Promise<void>;
}): Promise<{ rawPersisted: boolean; canonicalPersisted: boolean }> {
  await params.persistRaw();
  try {
    await params.persistCanonical();
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    Object.assign(wrapped, {
      rawPersisted: true,
      canonicalPersisted: false,
    });
    throw wrapped;
  }
  return { rawPersisted: true, canonicalPersisted: true };
}
