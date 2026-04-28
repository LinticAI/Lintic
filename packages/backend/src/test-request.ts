import { Duplex } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';

interface InjectResponse {
  status: number;
  body: unknown;
  text: string;
  headers: Record<string, string>;
}

class MockSocket extends Duplex {
  remoteAddress = '127.0.0.1';
  encrypted = false;

  override _read(): void {}

  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  setTimeout(): this {
    return this;
  }

  override destroy(error?: Error): this {
    super.destroy(error);
    return this;
  }
}

async function inject(app: Express, input: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  jsonBody?: unknown;
}): Promise<InjectResponse> {
  const socket = new MockSocket() as unknown as Socket;
  const req = new IncomingMessage(socket);
  req.method = input.method;
  req.url = input.path;
  req.headers = input.headers;
  if (input.jsonBody !== undefined) {
    (req as IncomingMessage & { body?: unknown }).body = input.jsonBody;
  }

  const res = new ServerResponse(req);
  res.assignSocket(socket);

  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
    }
    return originalWrite(chunk as never, encoding as never, callback as never);
  }) as typeof res.write;

  res.end = ((chunk?: string | Buffer | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return originalEnd(chunk as never, encoding as never, callback as never);
  }) as typeof res.end;

  await new Promise<void>((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);

    (app as unknown as {
      handle: (request: IncomingMessage, response: ServerResponse, next: (err?: unknown) => void) => void;
    }).handle(req, res, (err?: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });

    if (input.body !== undefined) {
      req.push(input.body);
    }
    req.push(null);
  });

  const text = Buffer.concat(chunks).toString('utf8');
  const headers = Object.fromEntries(
    Object.entries(res.getHeaders()).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]),
  );
  const contentType = headers['content-type'] ?? '';
  const body = contentType.includes('application/json') && text.trim().length > 0
    ? JSON.parse(text)
    : text;

  return {
    status: res.statusCode,
    body,
    text,
    headers,
  };
}

class TestRequest {
  private readonly headers: Record<string, string> = {};
  private readonly queryParams = new URLSearchParams();
  private body?: string | Buffer;
  private jsonBody?: unknown;

  constructor(
    private readonly app: Express,
    private readonly method: string,
    private readonly path: string,
  ) {}

  set(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  send(payload: unknown): this {
    if (Buffer.isBuffer(payload)) {
      this.body = payload;
      return this;
    }

    if (typeof payload === 'string') {
      this.body = payload;
      return this;
    }

    this.jsonBody = payload;
    return this;
  }

  query(params: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          this.queryParams.append(key, String(item));
        }
        continue;
      }
      this.queryParams.set(key, String(value));
    }
    return this;
  }

  then<TResult1 = InjectResponse, TResult2 = never>(
    onfulfilled?: ((value: InjectResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<InjectResponse | TResult> {
    return this.execute().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<InjectResponse> {
    return this.execute().finally(onfinally ?? undefined);
  }

  private execute(): Promise<InjectResponse> {
    const suffix = this.queryParams.size > 0 ? `${this.path.includes('?') ? '&' : '?'}${this.queryParams.toString()}` : '';
    const finalPath = `${this.path}${suffix}`;
    const headers = { ...this.headers };

    if (this.body !== undefined && !headers['content-length']) {
      headers['content-length'] = String(Buffer.byteLength(this.body));
    }

    const input: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string | Buffer;
      jsonBody?: unknown;
    } = {
      method: this.method,
      path: finalPath,
      headers,
    };

    if (this.body !== undefined) {
      input.body = this.body;
    }
    if (this.jsonBody !== undefined) {
      input.jsonBody = this.jsonBody;
    }

    return inject(this.app, input);
  }
}

export default function request(app: Express) {
  return {
    get(path: string) {
      return new TestRequest(app, 'GET', path);
    },
    post(path: string) {
      return new TestRequest(app, 'POST', path);
    },
    put(path: string) {
      return new TestRequest(app, 'PUT', path);
    },
    patch(path: string) {
      return new TestRequest(app, 'PATCH', path);
    },
    delete(path: string) {
      return new TestRequest(app, 'DELETE', path);
    },
  };
}
