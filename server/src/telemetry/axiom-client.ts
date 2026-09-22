/**
 * AxiomClient handles the actual HTTP communication with Axiom Analytics.
 * It's responsible for sending event batches to the 'buildmy-house-telemetry' dataset.
 */

export interface AxiomEvent {
  [key: string]: any;
  _time?: number; // Optional timestamp in milliseconds
}

export interface SendBatchResult {
  success: boolean;
  error?: string;
  bytesIngested?: number;
}

export class AxiomClient {
  private apiToken: string;
  private datasetName: string;
  private baseUrl: string;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(
    apiToken: string = process.env.AXIOM_API_TOKEN || '',
    datasetName: string = 'buildmy-house-telemetry',
    baseUrl: string = process.env.AXIOM_BASE_URL || 'https://api.axiom.co',
  ) {
    this.apiToken = apiToken;
    this.datasetName = datasetName;
    this.baseUrl = baseUrl;
    this.maxRetries = 3;
    this.retryDelayMs = 100;
  }

  /**
   * Send a batch of events to Axiom.
   * Implements retry logic with exponential backoff.
   */
  async sendBatch(events: AxiomEvent[]): Promise<SendBatchResult> {
    if (events.length === 0) {
      return { success: true, bytesIngested: 0 };
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this._send(events);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries - 1) {
          const delayMs = this.retryDelayMs * Math.pow(2, attempt);
          await this._sleep(delayMs);
        }
      }
    }

    const errorMsg = lastError?.message || 'Unknown error';
    return {
      success: false,
      error: `Failed to send batch after ${this.maxRetries} attempts: ${errorMsg}`,
    };
  }

  /**
   * Internal method to actually send the HTTP request to Axiom.
   */
  private async _send(events: AxiomEvent[]): Promise<SendBatchResult> {
    if (!this.apiToken) {
      throw new Error('AXIOM_API_TOKEN is not configured');
    }

    const payload = {
      events: events.map((e) => ({
        ...e,
        _time: e._time || Date.now(),
      })),
    };

    const response = await fetch(`${this.baseUrl}/v1/datasets/${this.datasetName}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Axiom API error (${response.status}): ${text}`);
    }

    const result = (await response.json()) as { ingested?: number };
    return {
      success: true,
      bytesIngested: result.ingested,
    };
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
