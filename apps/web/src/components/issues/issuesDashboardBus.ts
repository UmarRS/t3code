// Tiny event bus so surfaces outside the issues dashboard (the command palette)
// can ask it to open the autonomous-mode prompt, rather than starting a run
// without the confirmation that explains what a run does.
const AUTONOMOUS_PROMPT_EVENT = "t3code:issues-autonomous-prompt";

export function requestAutonomousRunPrompt(): void {
  window.dispatchEvent(new CustomEvent(AUTONOMOUS_PROMPT_EVENT));
}

export function onAutonomousRunPrompt(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(AUTONOMOUS_PROMPT_EVENT, handler);
  return () => window.removeEventListener(AUTONOMOUS_PROMPT_EVENT, handler);
}
