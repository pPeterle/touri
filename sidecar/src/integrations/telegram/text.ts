/** Telegram counts message length in UTF-16 code units, which is what String.length measures. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * Splits a reply into messages under the limit, preferring line breaks. A chunk that ends inside a
 * code fence is closed there and the fence is reopened at the top of the next chunk.
 */
export const splitMessage = (text: string, limit = TELEGRAM_MESSAGE_LIMIT): Array<string> => {
  if (text.length <= limit) return text ? [text] : []
  const chunks: Array<string> = []
  let current: Array<string> = []
  let size = 0
  let fence: string | null = null
  let opener = ""
  // Room for a closing fence, its newline and the reopened fence line.
  const reserve = () => (fence ? fence.length + 1 : 0)
  const flush = () => {
    if (!current.length) return
    chunks.push(fence ? `${current.join("\n")}\n${fence}` : current.join("\n"))
    current = fence ? [opener] : []
    size = fence ? opener.length : 0
  }
  const push = (line: string) => {
    current.push(line)
    size += line.length + (current.length > 1 ? 1 : 0)
  }
  for (const line of text.split("\n")) {
    const budget = limit - reserve() - (fence ? opener.length + 1 : 0)
    if (line.length > budget) {
      flush()
      for (let start = 0; start < line.length; start += budget) {
        push(line.slice(start, start + budget))
        flush()
      }
    } else {
      if (size + line.length + 1 > limit - reserve()) flush()
      push(line)
    }
    const marker = line.match(FENCE)?.[1]
    if (marker && !fence) {
      fence = marker
      opener = line
    } else if (marker && fence && marker.startsWith(fence[0] ?? "`")) {
      fence = null
      opener = ""
    }
  }
  if (current.length && !(current.length === 1 && current[0] === opener && fence)) {
    fence = null
    chunks.push(current.join("\n"))
  }
  return chunks.filter((chunk) => chunk.trim().length > 0)
}
