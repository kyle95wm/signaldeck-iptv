import { useEffect, useMemo, useRef, useState } from 'react';

const OVERSCAN = 5;

function getViewportSize() {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export default function VirtualizedStreamList({
  items,
  itemHeight,
  className,
  itemKey,
  renderItem,
}) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(() => getViewportSize());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const onResize = () => {
      setViewport(getViewportSize());
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    containerRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [items, itemHeight]);

  const compactLayout = viewport.width <= 760;
  const maxHeight = compactLayout
    ? Math.min(viewport.height * 0.48, 420)
    : Math.min(viewport.height * 0.62, 640);
  const minVisibleRows = compactLayout ? 4 : 5;
  const containerHeight = Math.min(
    Math.max(itemHeight * minVisibleRows, maxHeight),
    Math.max(itemHeight, items.length * itemHeight),
  );

  const totalHeight = items.length * itemHeight;
  const visibleCount = Math.max(1, Math.ceil(containerHeight / itemHeight) + OVERSCAN * 2);
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - OVERSCAN);
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const offsetY = startIndex * itemHeight;

  const visibleItems = useMemo(() => {
    return items.slice(startIndex, endIndex);
  }, [endIndex, items, startIndex]);

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{ height: `${containerHeight}px` }}
    >
      <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map((item, index) => (
            <div key={itemKey(item)} style={{ minHeight: `${itemHeight}px` }}>
              {renderItem(item, startIndex + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
