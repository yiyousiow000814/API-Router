export function isNearBottom(element: { scrollTop: number; clientHeight: number; scrollHeight: number }, thresholdPx = 24): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - thresholdPx
}

