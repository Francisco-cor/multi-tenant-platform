export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function firstParam(
  searchParams: SearchParams,
  key: string,
): Promise<string | undefined> {
  const params = await searchParams;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}
