/** Requests already inside the adapter's session, deadline and coordination boundary. */
export interface ResourceRead {
  read(path: string): Promise<unknown>;
  check(): void;
}
