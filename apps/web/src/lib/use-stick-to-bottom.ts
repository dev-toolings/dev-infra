import * as React from "react";

const STICK_THRESHOLD_PX = 48;

/** Keeps a log list on its newest line until the reader scrolls up. */
export function useStickToBottom(hasContent: boolean) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const list = React.useRef<HTMLOListElement>(null);
  const following = React.useRef(true);
  const [stuck, setStuck] = React.useState(true);

  const follow = React.useCallback((next: boolean) => {
    following.current = next;
    setStuck(next);
    // A capped list drops a row for each new one, so its height stays the same: anchoring would pull a follower up,
    // and without it the text would slide under someone reading older lines.
    if (scroller.current) scroller.current.style.overflowAnchor = next ? "none" : "auto";
  }, []);
  const toBottom = () => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    follow(true);
  };
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    follow(scrollHeight - scrollTop - clientHeight < STICK_THRESHOLD_PX);
  };

  // ResizeObserver runs after layout and before paint, so a new line is never drawn above the bottom.
  // Do not use flex-col-reverse here: the Sheet scroll lock misreads its negative scrollTop and cancels the wheel.
  React.useEffect(() => {
    const box = scroller.current;
    if (!box || !list.current) return;
    box.style.overflowAnchor = following.current ? "none" : "auto";
    const observer = new ResizeObserver(() => { if (following.current) box.scrollTop = box.scrollHeight; });
    observer.observe(list.current);
    observer.observe(box);
    return () => observer.disconnect();
  }, [hasContent]);

  return { scroller, list, stuck, onScroll, toBottom };
}
