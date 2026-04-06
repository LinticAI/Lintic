import { render, screen } from '@testing-library/react';
import { SplitPane } from './SplitPane.js';

describe('SplitPane', () => {
  test('renders left and right panes', () => {
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} />);
    expect(screen.getByTestId('pane-left')).toBeInTheDocument();
    expect(screen.getByTestId('pane-right')).toBeInTheDocument();
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
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} />);
    expect(screen.getByTestId('split-divider')).toBeInTheDocument();
  });

  test('divider has correct ARIA role and orientation', () => {
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} />);
    const divider = screen.getByTestId('split-divider');
    expect(divider).toHaveAttribute('role', 'separator');
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  });

  test('left pane starts at 50% width', () => {
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} />);
    const leftPane = screen.getByTestId('pane-left');
    expect(leftPane).toHaveStyle({ '--split-left-pct': '50%' });
  });

  test('allows both panes to shrink when content is wide', () => {
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} />);
    expect(screen.getByTestId('pane-left')).toHaveClass('min-w-0');
    expect(screen.getByTestId('pane-right')).toHaveClass('min-w-0');
  });

  test('stacks below the desktop breakpoint and switches to row layout above it', () => {
    render(<SplitPane left={<div>Left</div>} right={<div>Right</div>} />);
    expect(screen.getByTestId('pane-left')).toHaveClass('basis-full');
    expect(screen.getByTestId('pane-left')).toHaveClass('min-[920px]:basis-[var(--split-left-pct)]');
    expect(screen.getByTestId('split-divider')).toHaveClass('min-[920px]:block');
  });
});
