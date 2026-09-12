export const seed = '# Disposable Pi feasibility fixture\n';
export const interruptCommand = "printf 'started\\n' > interrupted.txt; sleep 30; printf 'finished\\n' >> interrupted.txt";
export const prompts = {
  first: 'Read README.md, then create notes.txt containing exactly alpha followed by a newline.',
  followup: 'Read notes.txt, replace alpha with beta using the edit tool, then read the file again.',
  denied: 'Create protected.txt containing denied followed by a newline.',
  interrupted: 'Run the preregistered shell write-and-wait command.',
};
export const scripts = {
  first: [
    { id: 'first-read', name: 'read', arguments: { path: 'README.md' } },
    { id: 'first-write', name: 'write', arguments: { path: 'notes.txt', content: 'alpha\n' } },
  ],
  followup: [
    { id: 'followup-read', name: 'read', arguments: { path: 'notes.txt' } },
    { id: 'followup-edit', name: 'edit', arguments: { path: 'notes.txt', edits: [{ oldText: 'alpha', newText: 'beta' }] } },
    { id: 'followup-readback', name: 'read', arguments: { path: 'notes.txt' } },
  ],
  denied: [{ id: 'denied-write', name: 'write', arguments: { path: 'protected.txt', content: 'denied\n' } }],
  interrupted: [{ id: 'interrupted-bash', name: 'bash', arguments: { command: interruptCommand } }],
};
export function expectedCalls(id) {
  return id.startsWith('baseline-') ? [...scripts.first, ...scripts.followup] : scripts[id === 'denied-write' ? 'denied' : 'interrupted'];
}
