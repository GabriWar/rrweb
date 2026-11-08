<script lang="ts">
  import { untrack } from 'svelte';

  // Upstream rrweb #1928 timeline marker, in runes (the fork's player is Svelte 5).
  let {
    name,
    text,
    background,
    position,
    disabled = false,
    dismissalVersion = 0,
    onseek,
    onfocustimeline,
  }: {
    name: string;
    text: string;
    background: string;
    position: string;
    disabled?: boolean;
    dismissalVersion?: number;
    onseek?: () => void;
    onfocustimeline?: () => void;
  } = $props();

  let dismissed = $state(false);
  let marker = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();

  function dismiss() {
    if (panel?.contains(document.activeElement)) {
      if (disabled) onfocustimeline?.();
      else marker?.focus();
    }
    dismissed = true;
  }

  $effect(() => {
    if (dismissalVersion) untrack(dismiss);
  });

  let alignment = $derived(
    parseFloat(position) < 20
      ? 'left'
      : parseFloat(position) > 80
        ? 'right'
        : 'center',
  );
</script>

<div class="rr-custom-event-container" style:left={position}>
  <button
    bind:this={marker}
    type="button"
    class="rr-custom-event"
    aria-label={`${name}: ${text}`}
    aria-haspopup="dialog"
    {disabled}
    onclick={(event) => {
      event.stopPropagation();
      onseek?.();
    }}
    onmouseenter={() => (dismissed = false)}
    onfocus={() => (dismissed = false)}
  >
    <span class="rr-custom-event__tick" style:background></span>
  </button>
  {#if !dismissed}
    <!-- The nonmodal timeline marker panel needs focus for native scrolling; its clicks must not seek. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
    <div
      bind:this={panel}
      class="rr-custom-event__timeline-marker-panel"
      class:left={alignment === 'left'}
      class:right={alignment === 'right'}
      role="dialog"
      aria-label={name}
      tabindex="0"
      onclick={(event) => event.stopPropagation()}
    >
      <strong>{name}</strong>
      <span>{text}</span>
    </div>
  {/if}
</div>

<style>
  .rr-custom-event-container {
    position: absolute;
    top: 2px;
    transform: translate(-50%, -50%);
    width: 20px;
    height: 24px;
    z-index: 1;
  }

  .rr-custom-event {
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
  }

  .rr-custom-event-container:hover,
  .rr-custom-event-container:focus-within {
    z-index: 2;
  }

  .rr-custom-event:focus-visible {
    outline: 2px solid rgb(73, 80, 246);
    outline-offset: 2px;
    border-radius: 3px;
  }

  .rr-custom-event:disabled {
    cursor: not-allowed;
  }

  .rr-custom-event__tick {
    display: block;
    width: 10px;
    height: 5px;
    margin: auto;
  }

  .rr-custom-event__timeline-marker-panel {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: var(--rr-timeline-marker-panel-width, 280px);
    box-sizing: border-box;
    padding: 12px 14px;
    background: #242936;
    color: #fff;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    font: 14px/1.5 system-ui, sans-serif;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
    max-height: var(--rr-timeline-marker-panel-height, 240px);
    overflow-y: auto;
  }

  .rr-custom-event__timeline-marker-panel strong,
  .rr-custom-event__timeline-marker-panel span {
    display: block;
    white-space: pre-wrap;
  }

  .rr-custom-event__timeline-marker-panel strong {
    margin-bottom: 4px;
  }

  .rr-custom-event__timeline-marker-panel.left {
    left: 0;
    transform: none;
  }

  .rr-custom-event__timeline-marker-panel.right {
    left: auto;
    right: 0;
    transform: none;
  }

  .rr-custom-event-container:hover .rr-custom-event__timeline-marker-panel,
  .rr-custom-event-container:focus-within .rr-custom-event__timeline-marker-panel {
    display: block;
  }
</style>
