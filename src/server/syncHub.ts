import { createHash } from "node:crypto";
import { createServer, IncomingMessage, request, Server as HttpServer, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  AckMessage,
  ClientMessage,
  DeleteMessage,
  HelloMessage,
  ManifestSnapshot,
  PullMessage,
  PROTOCOL_VERSION,
  PutDeltaMessage,
  PutMessage,
  RemoteChangeMessage,
  ServerMessage
} from "../shared/protocol";
import { ManifestStore } from "./manifestStore";
import { FileStore } from "./fileStore";
import { applyByteDelta } from "../shared/byteDelta";

interface ClientState {
  socket: WebSocket;
  deviceId: string;
  deviceName: string;
  vaultId: string;
}

interface SyncHubOptions {
  host: string;
  port: number;
  vaultId: string;
  vaultAliases?: string[];
  syncToken: string;
  manifestStore: ManifestStore;
  fileStore: FileStore;
  proxyTarget?: string;
}

export class SyncHub {
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly pageSnapshots = new Map<number, { snapshot: ManifestSnapshot; expiresAt: number }>();

  constructor(private readonly options: SyncHubOptions) {
    this.httpServer = createServer((req, res) => {
      try {
        this.handleHttp(req, res);
      } catch {
        this.failHttpRequest(res);
      }
    });
    this.wsServer = new WebSocketServer({ server: this.httpServer, path: "/sync", perMessageDeflate: false });
    this.wsServer.on("connection", (socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.options.port, this.options.host, resolve);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.clients.keys()) {
      socket.close();
    }
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  address(): AddressInfo {
    return this.httpServer.address() as AddressInfo;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === "/healthz") {
      const snapshot = this.options.manifestStore.snapshot();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, revision: snapshot.revision, files: Object.keys(snapshot.files).length }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/manifest") {
      if (!this.isHttpAuthorized(req, url)) {
        this.unauthorized(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.options.manifestStore.snapshot()));
      return;
    }
    if (url.pathname === "/manifest-page") {
      if (!this.isHttpAuthorized(req, url)) {
        this.unauthorized(res);
        return;
      }
      const revisionParam = url.searchParams.get("revision");
      const requestedRevision = revisionParam === null ? undefined : Number(revisionParam);
      if (requestedRevision !== undefined && (!Number.isSafeInteger(requestedRevision) || requestedRevision < 0)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid snapshot revision" }));
        return;
      }
      const snapshot = this.manifestPageSnapshot(requestedRevision);
      if (!snapshot) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "snapshot expired; retry" }));
        return;
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid page" }));
        return;
      }
      const limit = Math.min(requestedLimit, 100);
      const entries = Object.entries(snapshot.files);
      const page = entries.slice(offset, offset + limit);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          vaultId: snapshot.vaultId,
          revision: snapshot.revision,
          totalFiles: entries.length,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null,
          files: Object.fromEntries(page)
        })
      );
      return;
    }
    if (url.pathname === "/oplog") {
      void this.handleHttpOperationLog(req, res, url).catch(() => this.failHttpRequest(res));
      return;
    }
    if (url.pathname === "/file") {
      void this.handleHttpFile(req, res, url).catch(() => this.failHttpRequest(res));
      return;
    }
    if (url.pathname === "/file-chunk") {
      void this.handleHttpFileChunk(req, res, url).catch(() => this.failHttpRequest(res));
      return;
    }
    if (this.options.proxyTarget) {
      this.proxyHttp(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  private manifestPageSnapshot(revision?: number): ManifestSnapshot | undefined {
    this.options.manifestStore.assertReadable();
    const now = Date.now();
    for (const [key, cached] of this.pageSnapshots) {
      if (cached.expiresAt <= now) this.pageSnapshots.delete(key);
    }
    if (revision !== undefined) {
      const cached = this.pageSnapshots.get(revision);
      if (cached) return cached.snapshot;
    }
    const current = this.options.manifestStore.snapshot();
    if (revision !== undefined && current.revision !== revision) return undefined;
    this.pageSnapshots.set(current.revision, { snapshot: current, expiresAt: now + 120_000 });
    while (this.pageSnapshots.size > 8) this.pageSnapshots.delete(this.pageSnapshots.keys().next().value!);
    return current;
  }

  private failHttpRequest(res: ServerResponse): void {
    // Storage errors can contain sensitive endpoint details. Return a generic
    // failure without allowing an unhandled rejection to terminate the server.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "sync storage request failed" }));
  }

  private async handleHttpOperationLog(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.isHttpAuthorized(req, url)) {
      this.unauthorized(res);
      return;
    }
    const after = Math.max(0, Number(url.searchParams.get("after") ?? "0"));
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "100")), 500);
    const entries = await this.options.manifestStore.readOperationLog(after, limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      entries,
      nextAfter: entries.at(-1)?.revision ?? after
    }));
  }

  private async handleHttpFileChunk(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.isHttpAuthorized(req, url)) {
      this.unauthorized(res);
      return;
    }
    const path = url.searchParams.get("path");
    if (!path) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "path is required" }));
      return;
    }
    const entry = this.options.manifestStore.snapshot().files[path];
    if (!entry || entry.deleted) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "file not found" }));
      return;
    }
    const expectedHash = url.searchParams.get("hash");
    if (expectedHash && expectedHash !== entry.hash) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "file changed during download" }));
      return;
    }
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const requestedLength = Number(url.searchParams.get("length") ?? "32768");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLength) || requestedLength < 1
      || offset > entry.size || (entry.size > 0 && offset === entry.size)) {
      res.writeHead(416, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid file range" }));
      return;
    }
    const length = Math.min(requestedLength, 65536, entry.size - offset);
    const chunk = length === 0 ? Buffer.alloc(0) : await this.options.manifestStore.readEntryRange(entry, offset, length);
    if (!chunk) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "object not found" }));
      return;
    }
    if (chunk.length !== length) throw new Error("Stored file length does not match manifest");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-obsidian-sync-size": String(entry.size),
      "x-obsidian-sync-hash": entry.hash,
      "x-obsidian-sync-next-offset": String(offset + chunk.length < entry.size ? offset + chunk.length : -1)
    });
    res.end(chunk);
  }

  private async handleHttpFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.isHttpAuthorized(req, url)) {
      this.unauthorized(res);
      return;
    }
    const path = url.searchParams.get("path");
    if (!path) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "path is required" }));
      return;
    }
    const entry = this.options.manifestStore.snapshot().files[path];
    if (!entry || entry.deleted) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "file not found" }));
      return;
    }
    const content = await this.options.manifestStore.readEntryContent(entry);
    if (!content) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "object not found" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-obsidian-sync-hash": entry.hash,
      "x-obsidian-sync-revision": String(entry.revision)
    });
    res.end(content);
  }

  private isHttpAuthorized(req: IncomingMessage, url: URL): boolean {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    return bearer === this.options.syncToken;
  }

  private unauthorized(res: ServerResponse): void {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }

  private proxyHttp(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(rawUrl) || rawUrl.startsWith("//")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "absolute proxy URLs are not allowed" }));
      return;
    }

    const target = new URL(rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`, this.options.proxyTarget);
    const { authorization: _authorization, host: _host, ...headers } = req.headers;
    const proxyReq = request(
      target,
      {
        method: req.method,
        headers: {
          ...headers,
          host: target.host
        }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    });
    req.pipe(proxyReq);
  }

  private handleConnection(socket: WebSocket): void {
    socket.on("message", (raw) => {
      void this.handleMessage(socket, raw.toString()).catch(() => {
        this.send(socket, { type: "error", code: "server_error", message: "Sync request failed; reconnecting safely" });
        // The client retains its queue and retries on reconnect. Merely
        // reporting an error can otherwise leave the upload in-flight for
        // minutes, even after the storage service recovers.
        socket.close(1011, "Temporary sync failure");
      });
    });
    socket.on("close", () => {
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const message = JSON.parse(raw) as ClientMessage;
    if (message.type === "hello") {
      await this.handleHello(socket, message);
      return;
    }

    const client = this.clients.get(socket);
    if (!client) {
      this.send(socket, { type: "error", code: "unauthorized", message: "Send hello before sync messages" });
      socket.close();
      return;
    }

    if (message.type === "put") {
      await this.handlePut(client, message);
      return;
    }
    if (message.type === "put-delta") {
      await this.handlePutDelta(client, message);
      return;
    }
    if (message.type === "delete") {
      await this.handleDelete(client, message);
      return;
    }
    if (message.type === "pull") {
      await this.handlePull(client, message);
      return;
    }
  }

  private async handleHello(socket: WebSocket, message: HelloMessage): Promise<void> {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.send(socket, { type: "error", code: "protocol_version", message: "Unsupported protocol version" });
      socket.close();
      return;
    }
    if (message.token !== this.options.syncToken) {
      this.send(socket, { type: "error", code: "unauthorized", message: "Invalid sync token" });
      socket.close();
      return;
    }
    if (!this.isAcceptedVaultId(message.vaultId)) {
      this.send(socket, { type: "error", code: "vault_mismatch", message: "Vault id does not match this sync service" });
      socket.close();
      return;
    }

    this.clients.set(socket, {
      socket,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      vaultId: message.vaultId
    });
    this.send(socket, { type: "ready", revision: this.options.manifestStore.snapshot().revision, capabilities: ["put-delta-v1"] });
  }

  private async handlePutDelta(client: ClientState, message: PutDeltaMessage): Promise<void> {
    if (!/\.(md|markdown)$/i.test(message.path) || typeof message.middleBase64 !== "string"
      || !Number.isSafeInteger(message.size) || message.size < 0) {
      this.send(client.socket, { type: "ack", opId: message.opId, status: "ignored", message: "Invalid delta request" });
      return;
    }
    const previous = await this.options.manifestStore.findPutReceipt({ opId: message.opId, path: message.path,
      baseRevision: message.baseRevision, hash: message.hash, size: message.size, deviceId: client.deviceId });
    if (previous) {
      if (previous.kind === "accepted") {
        this.send(client.socket, { type: "ack", opId: message.opId, status: "accepted", entry: previous.entry });
      } else if (previous.kind === "conflict") {
        const canonical = await this.options.manifestStore.readEntryContent(previous.canonicalEntry);
        this.send(client.socket, { type: "ack", opId: message.opId, status: "conflict", entry: previous.entry,
          canonicalEntry: previous.canonicalEntry, canonicalContentBase64: canonical?.toString("base64") });
      } else {
        this.send(client.socket, { type: "ack", opId: message.opId, status: "ignored", message: previous.message });
      }
      return;
    }
    const current = this.options.manifestStore.snapshot().files[message.path];
    if (!current || current.deleted || current.revision !== message.baseRevision || current.hash !== message.baseHash) {
      const canonical = current && !current.deleted ? await this.options.manifestStore.readEntryContent(current) : undefined;
      this.send(client.socket, { type: "ack", opId: message.opId, status: current ? "stale" : "ignored", entry: current,
        canonicalContentBase64: canonical?.toString("base64"), message: "Delta base is no longer current" });
      return;
    }
    const base = await this.options.manifestStore.readEntryContent(current);
    if (!base || base.length !== current.size || createHash("sha256").update(base).digest("hex") !== current.hash) {
      throw new Error("Stored delta base failed integrity verification");
    }
    const bytes = applyByteDelta(base, {
      prefixLength: message.prefixLength, suffixLength: message.suffixLength, middle: Buffer.from(message.middleBase64, "base64")
    });
    const content = Buffer.from(bytes);
    if (content.length !== message.size || createHash("sha256").update(content).digest("hex") !== message.hash) {
      this.send(client.socket, { type: "ack", opId: message.opId, status: "ignored", message: "Delta failed integrity verification" });
      return;
    }
    await this.handlePut(client, { type: "put", opId: message.opId, path: message.path, baseRevision: message.baseRevision,
      hash: message.hash, size: message.size, mtime: message.mtime, contentBase64: content.toString("base64") });
  }

  private isAcceptedVaultId(vaultId: string): boolean {
    return vaultId === this.options.vaultId || (this.options.vaultAliases ?? []).includes(vaultId);
  }

  private async handlePut(client: ClientState, message: PutMessage): Promise<void> {
    const content = Buffer.from(message.contentBase64, "base64");
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== message.hash || content.length !== message.size) {
      this.send(client.socket, {
        type: "ack",
        opId: message.opId,
        status: "ignored",
        message: "Content hash or size does not match payload"
      });
      return;
    }

    const result = await this.options.manifestStore.applyPut({
      opId: message.opId,
      path: message.path,
      content,
      hash,
      size: content.length,
      baseRevision: message.baseRevision,
      deviceId: client.deviceId,
      deviceName: client.deviceName,
      mtime: message.mtime
    });

    if (result.kind === "ignored") {
      this.send(client.socket, { type: "ack", opId: message.opId, status: "ignored", message: result.message });
      return;
    }

    if (result.kind === "stale") {
      const canonicalContent = result.entry.deleted ? undefined : await this.options.manifestStore.readEntryContent(result.entry);
      this.send(client.socket, {
        type: "ack",
        opId: message.opId,
        status: "stale",
        entry: result.entry,
        canonicalContentBase64: canonicalContent?.toString("base64"),
        message: result.message
      });
      return;
    }

    if (result.kind === "conflict") {
      const canonicalContent = await this.options.manifestStore.readEntryContent(result.canonicalEntry);
      const ack: AckMessage = {
        type: "ack",
        opId: message.opId,
        status: "conflict",
        entry: result.entry,
        canonicalEntry: result.canonicalEntry,
        canonicalContentBase64: canonicalContent?.toString("base64")
      };
      this.send(client.socket, ack);
      if (!result.replayed) this.broadcast(client.deviceId, {
        type: "remote-change",
        originDeviceId: client.deviceId,
        action: "put",
        entry: result.entry,
        contentBase64: content.toString("base64")
      });
      return;
    }

    this.send(client.socket, { type: "ack", opId: message.opId, status: "accepted", entry: result.entry });
    if (!result.replayed) this.broadcast(client.deviceId, {
      type: "remote-change",
      originDeviceId: client.deviceId,
      action: "put",
      entry: result.entry,
      contentBase64: content.toString("base64")
    });
  }

  private async handleDelete(client: ClientState, message: DeleteMessage): Promise<void> {
    const result = await this.options.manifestStore.applyDelete({
      opId: message.opId,
      path: message.path,
      baseRevision: message.baseRevision,
      deviceId: client.deviceId,
      deviceName: client.deviceName
    });

    if (result.kind === "ignored") {
      this.send(client.socket, { type: "ack", opId: message.opId, status: "ignored", message: result.message });
      return;
    }
    if (result.kind === "stale") {
      this.send(client.socket, { type: "ack", opId: message.opId, status: "stale", entry: result.entry, message: result.message });
      return;
    }

    this.send(client.socket, { type: "ack", opId: message.opId, status: "deleted", entry: result.entry });
    if (!result.replayed) this.broadcast(client.deviceId, {
      type: "remote-change",
      originDeviceId: client.deviceId,
      action: "delete",
      entry: result.entry
    });
  }

  private async handlePull(client: ClientState, message: PullMessage): Promise<void> {
    const entry = this.options.manifestStore.snapshot().files[message.path];
    if (!entry) {
      this.send(client.socket, { type: "file-content", opId: message.opId, status: "missing", entry: {
        path: message.path,
        hash: "",
        size: 0,
        mtime: 0,
        revision: 0,
        updatedAt: new Date().toISOString(),
        updatedBy: "server",
        deleted: true
      } });
      return;
    }

    if (entry.deleted) {
      this.send(client.socket, { type: "file-content", opId: message.opId, status: "deleted", entry });
      return;
    }

    const content = await this.options.manifestStore.readEntryContent(entry);
    if (!content) {
      this.send(client.socket, { type: "file-content", opId: message.opId, status: "missing", entry });
      return;
    }

    await this.sendChunkedFile(client.socket, message.opId, entry, content);
  }

  private async sendSnapshot(socket: WebSocket): Promise<void> {
    const snapshot = this.options.manifestStore.snapshot();
    const entries = Object.entries(snapshot.files);
    await this.sendAsync(socket, {
      type: "snapshot-start",
      vaultId: snapshot.vaultId,
      revision: snapshot.revision,
      totalFiles: entries.length
    });
    for (let i = 0; i < entries.length; i += 25) {
      await this.sendAsync(socket, {
        type: "snapshot-chunk",
        files: Object.fromEntries(entries.slice(i, i + 25))
      });
      await delay(1);
    }
    await this.sendAsync(socket, { type: "snapshot-end" });
  }

  private async sendChunkedFile(socket: WebSocket, opId: string, entry: RemoteChangeMessage["entry"], content: Buffer): Promise<void> {
    await this.sendAsync(socket, { type: "file-content-start", opId, status: "found", entry });
    const chunkSize = 8 * 1024;
    for (let offset = 0, index = 0; offset < content.length; offset += chunkSize, index += 1) {
      await this.sendAsync(socket, {
        type: "file-content-chunk",
        opId,
        index,
        contentBase64: content.subarray(offset, offset + chunkSize).toString("base64")
      });
      await delay(2);
    }
    await this.sendAsync(socket, { type: "file-content-end", opId });
  }

  private broadcast(originDeviceId: string, message: RemoteChangeMessage): void {
    for (const client of this.clients.values()) {
      if (client.deviceId !== originDeviceId) {
        this.send(client.socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private async sendAsync(socket: WebSocket, message: ServerMessage): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
