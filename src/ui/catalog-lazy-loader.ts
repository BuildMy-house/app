/**
 * catalog-lazy-loader.ts — Lazy-load visible thumbnails using Intersection Observer.
 *
 * Instead of fetching all 1509 R2 thumbnail images on open, only fetch those
 * visible in the viewport + buffer. Dramatically reduces resource usage and
 * improves initial load time. Local asset thumbnails still load eagerly
 * (bundled, small, embedded).
 */

interface PendingLoad {
  element: HTMLImageElement
  url: string
  retry: number
}

export class CatalogLazyLoader {
  private pendingLoads = new Map<HTMLElement, PendingLoad>()
  private loadedUrls = new Set<string>()
  private observer: IntersectionObserver | null = null
  private readonly maxRetries = 2
  private readonly retryDelayMs = 500

  constructor() {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const card = entry.target as HTMLElement
          if (entry.isIntersecting) {
            this.loadCard(card)
          } else {
            // Optional: unload thumbnails far from viewport to save memory
            // (disabled by default — most galleries don't have that many items)
          }
        }
      },
      {
        root: null,
        rootMargin: '100px', // Start loading 100px before entering viewport
        threshold: 0.01,
      },
    )
  }

  /**
   * Observe a catalog card for visibility and lazy-load its thumbnail.
   * Call this when the card is mounted into the DOM (already happens in
   * renderCard() via updateWindow()).
   */
  observe(card: HTMLElement, thumbUrl: string | null): void {
    if (!thumbUrl || !this.observer) return

    // Skip if already loaded (or queued for load)
    if (this.loadedUrls.has(thumbUrl) || this.pendingLoads.has(card)) {
      this.applyThumbnail(card, thumbUrl)
      return
    }

    // Register for intersection observation
    const img = card.querySelector<HTMLImageElement>('.catalog-thumbnail')
    if (!img) return

    this.pendingLoads.set(card, { element: img, url: thumbUrl, retry: 0 })
    this.observer.observe(card)
  }

  /**
   * Stop observing a card (called when the card is removed from the DOM).
   * Cleans up to avoid memory leaks in virtualized grids.
   */
  unobserve(card: HTMLElement): void {
    if (!this.observer) return
    this.observer.unobserve(card)
    this.pendingLoads.delete(card)
  }

  /**
   * Explicitly cancel all pending loads. Used when navigating away from
   * the catalog panel.
   */
  dispose(): void {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
    this.pendingLoads.clear()
  }

  private loadCard(card: HTMLElement): void {
    const pending = this.pendingLoads.get(card)
    if (!pending) return

    const { element: img, url } = pending

    // Fetch the thumbnail image
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob)
        img.src = blobUrl
        img.alt = 'Model thumbnail'
        this.loadedUrls.add(url)
        this.pendingLoads.delete(card)
        // Stop observing once loaded
        if (this.observer) this.observer.unobserve(card)
      })
      .catch((err) => {
        const { retry } = pending
        if (retry < this.maxRetries) {
          // Retry on network error
          pending.retry++
          setTimeout(() => this.loadCard(card), this.retryDelayMs)
        } else {
          // Give up after retries; keep the color swatch fallback
          console.warn(`Failed to load thumbnail: ${url}`, err)
          this.pendingLoads.delete(card)
          if (this.observer) this.observer.unobserve(card)
        }
      })
  }

  /**
   * Apply a cached thumbnail image to a card. Used when the thumbnail is
   * already loaded (or available locally).
   */
  private applyThumbnail(card: HTMLElement, thumbUrl: string): void {
    const img = card.querySelector<HTMLImageElement>('.catalog-thumbnail')
    if (!img) return
    img.src = thumbUrl
    img.alt = 'Model thumbnail'
  }
}
