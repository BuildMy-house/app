/**
 * model-upload-dialog.ts — Upload 3D models with drag-drop + progress.
 *
 * Opens as a modal overlay (same pattern as PreferencesDialog/AuthDialog).
 * Accepts GLB/OBJ/GLTF files via drag-drop or file picker.
 * On success, calls back with the new catalog entry so the caller can
 * refresh the catalog panel.
 */

export interface UploadResult {
  catalogId: string
  name: string
  category: string
  modelPath: string
  modelUrl?: string
  renderModelPath?: string | null
  thumbnailPath: string | null
}

export interface ModelUploadDialogOptions {
  /** Called after successful upload with the new catalog entry. */
  onUploadSuccess: (result: UploadResult) => void
  /** Optional: resolve a model path to a fetchable URL (for thumbnail preview). */
  modelUrlResolver?: (modelPath: string) => string
}

export class ModelUploadDialog {
  private overlay: HTMLDivElement
  private onUploadSuccess: (result: UploadResult) => void
  private modelUrlResolver?: (modelPath: string) => string

  // State
  private file: File | null = null
  private uploading = false
  private progress = 0
  private error = ''
  private dragActive = false

  // DOM refs
  private dropZone!: HTMLDivElement
  private fileInput!: HTMLInputElement
  private nameInput!: HTMLInputElement
  private categorySelect!: HTMLSelectElement
  private fileInfo!: HTMLDivElement
  private fileName!: HTMLSpanElement
  private fileSize!: HTMLSpanElement
  private progressContainer!: HTMLDivElement
  private progressFill!: HTMLDivElement
  private progressText!: HTMLSpanElement
  private errorDiv!: HTMLDivElement
  private uploadBtn!: HTMLButtonElement
  private cancelBtn!: HTMLButtonElement

  constructor(options: ModelUploadDialogOptions) {
    this.onUploadSuccess = options.onUploadSuccess
    this.modelUrlResolver = options.modelUrlResolver
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
    this.buildDOM()
    this.bindEvents()
  }

  open(): void {
    this.reset()
    document.body.appendChild(this.overlay)
    this.nameInput.focus()
  }

  private close(): void {
    this.overlay.remove()
    this.reset()
  }

  private reset(): void {
    this.file = null
    this.uploading = false
    this.progress = 0
    this.error = ''
    this.dragActive = false
    this.render()
  }

  private buildDOM(): void {
    this.overlay.innerHTML = `
      <div class="prefs-dialog model-upload-dialog">
        <h3>Upload Model</h3>

        <div class="upload-drop-zone">
          <p class="upload-drop-text">Drag & drop a GLB, OBJ, GLTF, or ZIP model bundle here</p>
          <p class="upload-or-text">or</p>
          <label class="upload-browse-btn">
            <input type="file" accept=".glb,.obj,.gltf,.zip" />
            Browse Files
          </label>
        </div>

        <div class="upload-file-info" style="display:none">
          <span class="upload-file-name"></span>
          <span class="upload-file-size"></span>
        </div>

        <div class="prefs-row">
          <label>Model Name *</label>
          <input class="dialog-input upload-name-input" type="text" placeholder="e.g., Oak Chair, Modern Sofa" />
        </div>

        <div class="prefs-row">
          <label>Category</label>
          <select class="dialog-input upload-category-select">
            <option value="Living">Living</option>
            <option value="Bedroom">Bedroom</option>
            <option value="Kitchen">Kitchen</option>
            <option value="Bathroom">Bathroom</option>
            <option value="Dining">Dining</option>
            <option value="Office">Office</option>
            <option value="Outdoor">Outdoor</option>
            <option value="Other">Other</option>
          </select>
        </div>

        <div class="upload-progress" style="display:none">
          <div class="upload-progress-bar">
            <div class="upload-progress-fill"></div>
          </div>
          <span class="upload-progress-text">Uploading... 0%</span>
        </div>

        <div class="upload-error" style="display:none"></div>

        <div class="prefs-actions">
          <button type="button" class="prefs-btn dialog-cancel">Cancel</button>
          <button type="button" class="prefs-btn prefs-ok upload-submit-btn" disabled>Upload Model</button>
        </div>
      </div>
    `

    this.dropZone = this.overlay.querySelector('.upload-drop-zone')!
    this.fileInput = this.overlay.querySelector('input[type="file"]')!
    this.nameInput = this.overlay.querySelector('.upload-name-input')!
    this.categorySelect = this.overlay.querySelector('.upload-category-select')!
    this.fileInfo = this.overlay.querySelector('.upload-file-info')!
    this.fileName = this.overlay.querySelector('.upload-file-name')!
    this.fileSize = this.overlay.querySelector('.upload-file-size')!
    this.progressContainer = this.overlay.querySelector('.upload-progress')!
    this.progressFill = this.overlay.querySelector('.upload-progress-fill')!
    this.progressText = this.overlay.querySelector('.upload-progress-text')!
    this.errorDiv = this.overlay.querySelector('.upload-error')!
    this.uploadBtn = this.overlay.querySelector('.upload-submit-btn')!
    this.cancelBtn = this.overlay.querySelector('.dialog-cancel')!
  }

  private bindEvents(): void {
    // Escape / backdrop / Cancel
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })
    this.cancelBtn.addEventListener('click', () => this.close())

    // Upload button
    this.uploadBtn.addEventListener('click', () => this.handleUpload())

    // File input change
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0]
      if (file) this.setFile(file)
    })

    // Drag events
    this.dropZone.addEventListener('dragenter', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.dragActive = true
      this.dropZone.classList.add('drag-active')
    })
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    this.dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.dragActive = false
      this.dropZone.classList.remove('drag-active')
    })
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.dragActive = false
      this.dropZone.classList.remove('drag-active')
      const file = e.dataTransfer?.files?.[0]
      if (file) this.setFile(file)
    })

    // Name input validation
    this.nameInput.addEventListener('input', () => this.updateUploadButton())
  }

  private setFile(file: File): void {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['glb', 'obj', 'gltf', 'zip'].includes(ext)) {
      this.error = 'Please upload a GLB, OBJ, GLTF, or ZIP model bundle'
      this.render()
      return
    }
    this.file = file
    this.error = ''
    // Auto-fill name from filename if empty
    if (!this.nameInput.value.trim()) {
      const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      this.nameInput.value = baseName
    }
    this.updateUploadButton()
    this.render()
  }

  private updateUploadButton(): void {
    const hasFile = this.file !== null
    const hasName = this.nameInput.value.trim().length > 0
    this.uploadBtn.disabled = !hasFile || !hasName || this.uploading
  }

  private async handleUpload(): Promise<void> {
    if (!this.file || !this.nameInput.value.trim()) return

    this.uploading = true
    this.progress = 0
    this.error = ''
    this.render()

    try {
      // Try server upload first
      const formData = new FormData()
      formData.append('file', this.file)
      formData.append('name', this.nameInput.value.trim())
      formData.append('category', this.categorySelect.value)

      const response = await fetch('/api/models/upload', {
        method: 'POST',
        body: formData,
      })

      if (response.ok) {
        const result = await response.json()
        this.progress = 100
        this.render()
        this.onUploadSuccess({
          catalogId: result.catalogId ?? `user#${this.file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
          name: this.nameInput.value.trim(),
          category: this.categorySelect.value,
          modelPath: result.modelPath ?? `models/user-${this.file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')}.glb`,
          modelUrl: result.modelUrl,
          renderModelPath: result.renderModelPath ?? null,
          thumbnailPath: result.thumbnailPath ?? null,
        })
        setTimeout(() => this.close(), 500)
        return
      }

      // Server upload failed — fall back to client-side import
      throw new Error('server-upload-fallback')
    } catch {
      // Client-side fallback: read file as blob URL and register locally
      try {
        const blob = new Blob([await this.file.arrayBuffer()])
        const blobUrl = URL.createObjectURL(blob)
        const catalogId = `user#${this.file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
        const name = this.nameInput.value.trim()

        this.progress = 100
        this.render()

        this.onUploadSuccess({
          catalogId,
          name,
          category: this.categorySelect.value,
          modelPath: blobUrl, // blob URL for client-side import
          thumbnailPath: null,
        })
        setTimeout(() => this.close(), 500)
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Upload failed'
        this.render()
      }
    } finally {
      this.uploading = false
    }
  }

  private render(): void {
    // File info
    if (this.file) {
      this.fileInfo.style.display = 'flex'
      this.fileName.textContent = this.file.name
      this.fileSize.textContent = `${(this.file.size / (1024 * 1024)).toFixed(2)} MB`
    } else {
      this.fileInfo.style.display = 'none'
    }

    // Progress
    if (this.uploading) {
      this.progressContainer.style.display = 'block'
      this.progressFill.style.width = `${this.progress}%`
      this.progressText.textContent = `Uploading... ${this.progress}%`
    } else {
      this.progressContainer.style.display = 'none'
    }

    // Error
    if (this.error) {
      this.errorDiv.style.display = 'block'
      this.errorDiv.textContent = this.error
    } else {
      this.errorDiv.style.display = 'none'
    }

    // Disable inputs while uploading
    this.nameInput.disabled = this.uploading
    this.categorySelect.disabled = this.uploading
    this.fileInput.disabled = this.uploading
    this.uploadBtn.disabled = !this.file || !this.nameInput.value.trim() || this.uploading
  }
}
