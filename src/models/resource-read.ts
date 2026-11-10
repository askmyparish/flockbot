/** Requests already inside the adapter's session, deadline and coordination boundary. */
export interface ResourceRead {
  read(path: string): Promise<unknown>;
  check(): void;
  /** Select provenance when validating an earlier or concurrently read response. */
  validationSource?(path: string): void;
}

/** Domain reads whose observed upstream contract uses form-encoded POST. */
export interface ResourceQuery extends ResourceRead {
  query(path: string, body?: string): Promise<unknown>;
}
