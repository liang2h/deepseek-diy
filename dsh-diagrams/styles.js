export const css = `
.dsh-diagram{position:relative;min-width:0;max-width:100%;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);overflow:hidden;font-family:inherit}
.dsh-diagram *{box-sizing:border-box}
.dsh-diagram-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-diagram-heading{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;font-weight:600}
.dsh-diagram-heading>svg{color:var(--dsw-alias-brand-primary);flex-shrink:0}
.dsh-diagram-kind{white-space:nowrap}
.dsh-diagram-tabs,.dsh-diagram-tools{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
.dsh-diagram-tabs{padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
.dsh-diagram button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:30px;padding:4px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.3;cursor:pointer;white-space:nowrap}
.dsh-diagram button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-diagram button:focus-visible,.dsh-diagram-viewport:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-diagram button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);font-weight:600}
.dsh-diagram button:disabled{opacity:.45;cursor:not-allowed}
.dsh-diagram-scale{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:38px;text-align:center;font-variant-numeric:tabular-nums}
.dsh-diagram-viewport{max-height:520px;overflow:auto;overscroll-behavior-x:contain;scrollbar-gutter:stable;position:relative;background:var(--dsw-alias-bg-base)}
.dsh-diagram-viewport[data-expanded=true]{max-height:none}
.dsh-diagram-art{padding:20px;width:max-content;min-width:100%;line-height:0}
.dsh-diagram-svg{max-width:none;flex-shrink:0}
.dsh-diagram-svg>svg{display:block;max-width:none!important;margin:0!important}
.dsh-diagram-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.dsh-diagram-status{padding:20px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}
.dsh-diagram-error{border-left:3px solid var(--dsw-alias-state-warn-primary)}
.dsh-diagram-error strong{display:block;color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-diagram-detail{display:block;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-diagram-source{padding:8px;max-height:520px;overflow:auto}
.dsh-diagram-source[data-expanded=true]{max-height:none}
.dsh-diagram-scratch{position:absolute;left:0;top:0;width:1600px;height:0;overflow:hidden;visibility:hidden;pointer-events:none}
@media(max-width:540px){.dsh-diagram-bar{padding:8px}.dsh-diagram-tools{gap:1px}.dsh-diagram button{min-height:34px;padding:5px 7px}.dsh-diagram-kind{display:none}.dsh-diagram-footer{padding:8px}.dsh-diagram-art{padding:16px}}
`;
