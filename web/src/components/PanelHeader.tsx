import { Maximize2, Minimize2, PanelRightClose } from 'lucide-react';
import './layout.css';

interface PanelHeaderProps<T extends string> {
  tabs: readonly { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
  expanded?: boolean;
  onExpanded?: (expanded: boolean) => void;
  onClose: () => void;
}

/** Panel-level navigation and layout controls, independent of the active content. */
export function PanelHeader<T extends string>({
  tabs,
  value,
  onSelect,
  expanded = false,
  onExpanded,
  onClose,
}: PanelHeaderProps<T>) {
  const label = tabs.find((tab) => tab.value === value)?.label ?? '';
  const expandLabel = expanded ? '恢复布局' : `放大${label}`;
  return (
    <header className="cw-panel-tabs">
      <div
        className="cw-panel-tab-buttons"
        role="tablist"
        aria-label="工作区"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const current = tabs.findIndex((tab) => tab.value === value);
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          if (!tabs[index]) return;
          onSelect(tabs[index].value);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
        }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={value === tab.value}
            tabIndex={value === tab.value ? 0 : -1}
            key={tab.value}
            onClick={() => onSelect(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {onExpanded && (
        <button
          type="button"
          className="cw-icon-button cw-desktop-only"
          aria-label={expandLabel}
          title={expandLabel}
          aria-pressed={expanded}
          onClick={() => onExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
      <button
        type="button"
        className="cw-icon-button cw-desktop-only"
        onClick={onClose}
        aria-label="收起面板"
        title="收起面板 (Ctrl+Alt+B)"
      >
        <PanelRightClose size={16} strokeWidth={1.75} />
      </button>
    </header>
  );
}
