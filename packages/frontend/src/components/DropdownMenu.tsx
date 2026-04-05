import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface DropdownMenuItem {
  value: string;
  label: string;
  meta?: string;
  icon?: ReactNode;
  selected?: boolean;
  testId?: string;
  onSelect: () => void;
}

interface DropdownMenuProps {
  label: string;
  items: DropdownMenuItem[];
  trigger: ReactNode | ((open: boolean) => ReactNode);
  widthClassName?: string;
  menuClassName?: string;
  menuPositionClassName?: string;
  triggerClassName?: string;
  itemClassName?: string;
  role?: 'listbox' | 'menu';
  showSelectedCheck?: boolean;
  dataTestId?: string;
}

export function DropdownMenu({
  label,
  items,
  trigger,
  widthClassName = 'min-w-[180px]',
  menuClassName = '',
  menuPositionClassName = 'left-0 right-0 top-[calc(100%+10px)]',
  triggerClassName = 'db-control flex w-full items-center justify-between px-3.5 py-2.5 text-left',
  itemClassName = 'db-menu-option flex w-full items-center justify-between px-3.5 py-2.5 text-left',
  role = 'menu',
  showSelectedCheck = true,
  dataTestId,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`relative flex items-center ${widthClassName}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup={role}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={triggerClassName}
        data-testid={dataTestId}
      >
        {typeof trigger === 'function' ? trigger(open) : trigger}
      </button>

      {open ? (
        <div className={`db-menu absolute z-20 overflow-hidden ${menuPositionClassName} ${menuClassName}`.trim()}>
          <div role={role} aria-label={label} className="max-h-72 overflow-auto p-2">
            {items.map((item) => {
              const optionRole = role === 'listbox' ? 'option' : 'menuitem';
              return (
                <button
                  key={item.value}
                  type="button"
                  role={optionRole}
                  aria-selected={role === 'listbox' ? item.selected : undefined}
                  onClick={() => {
                    item.onSelect();
                    setOpen(false);
                  }}
                  data-selected={item.selected ? 'true' : 'false'}
                  data-testid={item.testId}
                  className={itemClassName}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {item.icon ? (
                      <span className="inline-flex shrink-0 items-center" style={{ color: 'var(--db-text-tertiary)' }}>
                        {item.icon}
                      </span>
                    ) : null}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm" style={{ color: 'var(--db-text-primary)' }}>
                        {item.label}
                      </span>
                      {item.meta ? (
                        <span className="truncate text-xs" style={{ color: 'var(--db-text-tertiary)' }}>
                          {item.meta}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {showSelectedCheck && item.selected ? (
                    <Check size={14} style={{ color: 'var(--db-ring-focus)' }} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DropdownTriggerLabel({
  primary,
  secondary,
  open,
  compact = false,
  icon,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  open: boolean;
  compact?: boolean;
  icon?: ReactNode;
}) {
  return (
    <>
      <span className={`flex min-w-0 items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
        {icon ? (
          <span className="inline-flex shrink-0 items-center" style={{ color: 'var(--db-text-tertiary)' }}>
            {icon}
          </span>
        ) : null}
        {primary ? (
          <span className={secondary ? 'flex min-w-0 items-center gap-2' : 'flex min-w-0 items-center'}>
            <span className={compact ? 'truncate text-[12px] font-medium leading-none tracking-tight' : 'truncate text-sm font-medium'}>
              {primary}
            </span>
            {secondary ? (
              <span
                className={compact ? 'truncate text-[11px] leading-none' : 'truncate text-xs'}
                style={{ color: 'var(--db-text-tertiary)' }}
              >
                {secondary}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className={compact ? 'ml-1 inline-flex shrink-0 items-center' : 'ml-3 inline-flex shrink-0 items-center'}>
        <ChevronDown
          size={compact ? 15 : 16}
          style={{
            color: 'var(--db-text-tertiary)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 160ms ease',
          }}
        />
      </span>
    </>
  );
}
