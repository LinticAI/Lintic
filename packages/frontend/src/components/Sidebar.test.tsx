import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Sidebar } from './Sidebar.js';

describe('Sidebar', () => {
  test('marks the active workspace section and emits selections', () => {
    const onSelect = vi.fn();
    render(<Sidebar activeSection="database" onSelect={onSelect} />);

    expect(screen.getByRole('button', { name: 'Database' })).toHaveClass('bg-[#1A1A1A]');

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Git' }));

    expect(onSelect).toHaveBeenCalledWith('code');
    expect(onSelect).toHaveBeenCalledWith('git');
  });
});
