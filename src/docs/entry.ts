// One G-code's documentation, rendered.
//
// Shared rather than duplicated: the reference panel and the configuration
// panel show the same thing and there is no version of this where they should
// diverge. The markup keeps the reference panel's `gc-` class names so both get
// the same styling from one place — a second set that drifted would be visible
// to anyone who opened both.

import { html, nothing, type TemplateResult } from 'lit';
import type { GcodeEntry } from './types.js';

export function renderEntry(entry: GcodeEntry): TemplateResult {
  return html`
    <div class="gc-entry">
      <div class="gc-entry-head">
        <strong>${entry.code}</strong>
        <span>${entry.title}</span>
      </div>
      ${entry.support ? html`<div class="gc-support">${entry.support}</div>` : nothing}

      ${entry.params.length
        ? html`<div class="gc-section">Parameters</div>
            <div class="gc-params">
              ${entry.params.map(
                (p) => html`
                  <code class="gc-param ${p.required ? 'req' : ''}">${p.letter}</code>
                  <span>${p.text}${p.required ? html`<em> — required</em>` : nothing}</span>
                `,
              )}
            </div>`
        : nothing}

      ${entry.examples.length
        ? html`<div class="gc-section">Examples</div>
            <pre class="gc-examples">${entry.examples.join('\n')}</pre>`
        : nothing}

      ${entry.notes.length
        ? html`<div class="gc-section">Notes</div>
            <ul class="gc-notes">
              ${entry.notes.map((n) => html`<li>${n}</li>`)}
            </ul>`
        : nothing}

      ${entry.url
        ? html`<a class="hint gc-link" href=${entry.url} target="_blank" rel="noreferrer">
            Read it on docs.duet3d.com
          </a>`
        : nothing}
    </div>
  `;
}
