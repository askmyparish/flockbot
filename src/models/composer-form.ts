/** The composer's bracket-encoded metadata form, including ordered target arrays. */
export function composerForm(value: Record<string, unknown>): string {
  const data = new URLSearchParams();
  const append = (key: string, item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach((child, i) => {
        append(`${key}[${typeof child === "object" ? i : ""}]`, child);
      });
    } else if (item !== null && typeof item === "object") {
      for (const [name, child] of Object.entries(item))
        append(`${key}[${name}]`, child);
    } else if (item !== undefined)
      data.append(key, item === null ? "" : String(item));
  };
  for (const [key, item] of Object.entries(value)) append(key, item);
  return data.toString();
}
