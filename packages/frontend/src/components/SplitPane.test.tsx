import { render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { SplitPane } from './SplitPane.js';

describe('SplitPane', () => {
  function renderPane(props?: Partial<ComponentProps<typeof SplitPane>>) {
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} {...props} />);
    const leftPane = screen.getByText('Left').parentElement as HTMLElement;
    const rightPane = screen.getByText('Right').parentElement as HTMLElement;
    const divider = screen.getByRole('separator', { name: 'Resize panels' });
    const container = leftPane.parentElement as HTMLElement;

    return { container, leftPane, rightPane, divider };
  }

  test('renders left and right panes', () => {
    const { leftPane, rightPane } = renderPane();
    expect(leftPane).toBeInTheDocument();
    expect(rightPane).toBeInTheDocument();
  });

  test('renders left panel content', () => {
    render(<SplitPane left={<div>IDE Content</div>} right={<div>Chat</div>} />);
    expect(screen.getByText('IDE Content')).toBeInTheDocument();
  });

  test('renders right panel content', () => {
    render(<SplitPane left={<div>IDE</div>} right={<div>Chat Content</div>} />);
    expect(screen.getByText('Chat Content')).toBeInTheDocument();
  });

  test('renders the drag divider', () => {
    const { divider } = renderPane();
    expect(divider).toBeInTheDocument();
  });

  test('divider has correct ARIA role and orientation', () => {
    const { divider } = renderPane();
    expect(divider).toHaveAttribute('role', 'separator');
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  });

  test('left pane starts at 50% width', () => {
    const { leftPane } = renderPane();
    expect(leftPane).toHaveStyle({ flexBasis: '50%' });
  });

  test('allows both panes to shrink when content is wide', () => {
    const { leftPane, rightPane } = renderPane();
    expect(leftPane).toHaveClass('min-w-0');
    expect(rightPane).toHaveClass('min-w-0');
  });

  test('uses row layout by default and supports vertical orientation', () => {
    const horizontal = renderPane();
    expect(horizontal.container).toHaveClass('flex-row');
    expect(horizontal.divider).toHaveAttribute('aria-orientation', 'horizontal');

    const { container, divider } = (() => {
      const view = render(<SplitPane left={<div>Top</div>} right={<div>Bottom</div>} orientation="vertical" />);
      const topPane = screen.getByText('Top').parentElement as HTMLElement;
      return {
        container: topPane.parentElement as HTMLElement,
        divider: within(view.container).getByRole('separator', { name: 'Resize panels' }),
      };
    })();

    expect(container).toHaveClass('flex-col');
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  });
});
