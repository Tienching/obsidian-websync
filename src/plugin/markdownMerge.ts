export interface MarkdownMergeResult {
  merged: string;
  conflicted: boolean;
}

export function mergeMarkdown(base: string, local: string, remote: string): MarkdownMergeResult {
  if (local === remote) {
    return { merged: local, conflicted: false };
  }
  if (local === base) {
    return { merged: remote, conflicted: false };
  }
  if (remote === base) {
    return { merged: local, conflicted: false };
  }

  const append = mergeAppendOnly(base, local, remote);
  if (append) {
    return { merged: append, conflicted: false };
  }

  const lineMerge = mergeSameLineShape(base, local, remote);
  if (lineMerge) {
    return lineMerge;
  }

  return conflictResult(local, remote);
}

function mergeAppendOnly(base: string, local: string, remote: string): string | undefined {
  if (!local.startsWith(base) || !remote.startsWith(base)) {
    return undefined;
  }
  const localSuffix = local.slice(base.length);
  const remoteSuffix = remote.slice(base.length);
  if (!localSuffix) {
    return remote;
  }
  if (!remoteSuffix) {
    return local;
  }
  if (localSuffix === remoteSuffix) {
    return local;
  }
  return `${base}${remoteSuffix}${needsSeparator(remoteSuffix, localSuffix) ? "\n" : ""}${localSuffix}`;
}

function needsSeparator(left: string, right: string): boolean {
  return left.length > 0 && right.length > 0 && !left.endsWith("\n") && !right.startsWith("\n");
}

function mergeSameLineShape(base: string, local: string, remote: string): MarkdownMergeResult | undefined {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  if (baseLines.length !== localLines.length || baseLines.length !== remoteLines.length) {
    return undefined;
  }

  const merged: string[] = [];
  for (let i = 0; i < baseLines.length; i += 1) {
    const baseLine = baseLines[i];
    const localLine = localLines[i];
    const remoteLine = remoteLines[i];
    if (localLine === remoteLine) {
      merged.push(localLine);
    } else if (localLine === baseLine) {
      merged.push(remoteLine);
    } else if (remoteLine === baseLine) {
      merged.push(localLine);
    } else {
      return conflictResult(local, remote);
    }
  }

  return { merged: merged.join("\n"), conflicted: false };
}

function conflictResult(local: string, remote: string): MarkdownMergeResult {
  return {
    merged: `<<<<<<< LOCAL\n${local}${local.endsWith("\n") ? "" : "\n"}=======\n${remote}${remote.endsWith("\n") ? "" : "\n"}>>>>>>> REMOTE\n`,
    conflicted: true
  };
}
