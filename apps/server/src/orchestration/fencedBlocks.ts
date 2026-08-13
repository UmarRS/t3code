/**
 * Fenced-block extraction for the structured hand-offs agents write into their
 * final messages (`t3-issues` stories, `t3-review` verdicts).
 *
 * Fences are matched with an explicit scanner rather than one regex: a body may
 * itself contain triple backticks, and a greedy or lazy regex picks the wrong
 * terminator often enough to matter.
 */

const FENCE = "```";

/**
 * Every fenced body in a markdown message whose info string is exactly
 * `language`, in document order. Comparison is case-insensitive and ignores
 * surrounding whitespace, so an agent writing ```` ```T3-Issues ```` still
 * lands. An unterminated fence still yields its body: the agent's intent was
 * clear, and the caller reports the contents as unreadable rather than
 * silently ignoring them.
 */
export function extractFencedBlocks(markdown: string, language: string): ReadonlyArray<string> {
  const wanted = language.toLowerCase();
  const blocks: string[] = [];
  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length) {
    const opener = (lines[index] ?? "").trimStart();
    const isOpener =
      opener.startsWith(FENCE) && opener.slice(FENCE.length).trim().toLowerCase() === wanted;
    if (!isOpener) {
      index += 1;
      continue;
    }
    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trimStart().startsWith(FENCE)) {
        index += 1;
        break;
      }
      body.push(candidate);
      index += 1;
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}
