/** Explicit inert isolation supplements native <dialog> and also covers older WebViews. */
export function isolateModalBackground(dialog: HTMLElement): () => void {
  const isolated: Array<{ element: HTMLElement; inert: boolean }> = []
  let branch: HTMLElement | null = dialog
  while (branch?.parentElement) {
    const parent: HTMLElement = branch.parentElement
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !("inert" in sibling)) continue
      const element = sibling as HTMLElement
      isolated.push({ element, inert: element.inert })
      element.inert = true
    }
    branch = parent
  }
  return () => { for (const { element, inert } of isolated) element.inert = inert }
}
