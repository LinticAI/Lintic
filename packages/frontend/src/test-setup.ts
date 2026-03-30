/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import '@testing-library/jest-dom';
import { createElement, forwardRef } from 'react';
import type { ReactNode, Ref } from 'react';

// Mock framer-motion so animations are no-ops in jsdom.
// AnimatePresence becomes a passthrough so exit animations don't hold
// elements in the DOM and block DOM assertions.

interface MotionProps {
  children?: ReactNode;
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
  whileHover?: unknown;
  layout?: unknown;
  [key: string]: unknown;
}

vi.mock('framer-motion', () => {
  const makeMotion = (tag: string) =>
    forwardRef(({ children, initial: _i, animate: _a, exit: _e, transition: _t, whileHover: _wh, layout: _l, ...props }: MotionProps, ref: Ref<unknown>) =>
      createElement(tag, { ...props, ref }, children)
    );

  const motion = new Proxy({} as Record<string, ReturnType<typeof makeMotion>>, {
    get: (cache, tag: string) => {
      if (!cache[tag]) cache[tag] = makeMotion(tag);
      return cache[tag];
    },
  });

  return {
    motion,
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    useAnimation: () => ({ start: vi.fn(), stop: vi.fn() }),
    useMotionValue: (v: unknown) => ({ get: () => v, set: vi.fn() }),
  };
});
