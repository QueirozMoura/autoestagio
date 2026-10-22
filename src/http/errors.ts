export class HttpClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidUrlError extends HttpClientError {}

/** Falha de rede (DNS, conexão recusada, reset). Pode ser repetida. */
export class NetworkError extends HttpClientError {}

/** A requisição excedeu o tempo limite. Pode ser repetida. */
export class TimeoutError extends HttpClientError {}

export class TooManyRedirectsError extends HttpClientError {}

export class ResponseTooLargeError extends HttpClientError {}

export class RobotsDisallowedError extends HttpClientError {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`robots.txt não permite acessar ${url}: ${reason}`);
    this.url = url;
  }
}

export class ResponseValidationError extends HttpClientError {
  readonly issues: string[];

  constructor(url: string, issues: string[]) {
    super(`Resposta de ${url} fora do formato esperado:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

export class HttpStatusError extends HttpClientError {
  readonly status: number;
  readonly url: string;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    details: { status: number; url: string; retryAfterMs?: number | undefined },
  ) {
    super(message);
    this.status = details.status;
    this.url = details.url;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/** 401/403: a fonte recusou o acesso. Nunca é repetido nem contornado. */
export class BlockedError extends HttpStatusError {}

/** 429 persistente, ou `Retry-After` maior que o limite aceito. */
export class RateLimitedError extends HttpStatusError {}
