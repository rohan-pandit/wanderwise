export class RetrievalQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalQueryError";
  }
}
