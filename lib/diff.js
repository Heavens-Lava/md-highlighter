// Line diff between the version you last read and the current file.
// Returns hunks in current-file line numbers so the renderer can tint blocks.
'use strict';

const MAX_CELLS = 16e6; // DP budget; beyond this the middle is treated as one edit

/**
 * @returns {Array<{type:'added'|'edited'|'removed', start:number, end:number, oldText:string}>}
 *   start/end: 0-based line range in the NEW text (end exclusive; start===end for removals).
 */
function diffLines(oldText, newText) {
  const a = oldText.split(/\r?\n/), b = newText.split(/\r?\n/);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const ops = []; // 'e' equal, 'd' delete (from A), 'i' insert (from B)
  if ((A.length + 1) * (B.length + 1) > MAX_CELLS) {
    for (let i = 0; i < A.length; i++) ops.push('d');
    for (let j = 0; j < B.length; j++) ops.push('i');
  } else {
    const n = A.length, m = B.length, w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push('e'); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push('d'); i++; }
      else { ops.push('i'); j++; }
    }
    while (i < n) { ops.push('d'); i++; }
    while (j < m) { ops.push('i'); j++; }
  }
  // Group runs of non-equal ops into hunks.
  const hunks = [];
  let ai = pre, bj = pre, k = 0;
  while (k < ops.length) {
    if (ops[k] === 'e') { ai++; bj++; k++; continue; }
    const start = bj, removed = [];
    let ins = 0;
    while (k < ops.length && ops[k] !== 'e') {
      if (ops[k] === 'd') removed.push(a[ai++]); else { bj++; ins++; }
      k++;
    }
    const addedText = b.slice(start, bj).join('').trim();
    const removedText = removed.join('\n').trim();
    if (!addedText && !removedText) continue; // whitespace-only change
    hunks.push({
      type: ins && removed.length ? (addedText ? (removedText ? 'edited' : 'added') : 'removed') : ins ? 'added' : 'removed',
      start, end: bj, oldText: removedText,
    });
  }
  return hunks;
}

module.exports = { diffLines };
