/**
 * 自定义细滚动条（注入到标签页里的那段 CSS）。
 *
 * 曾经和悬浮球（已下线的 `dock.js`）住在一起，球没了之后这段还得留：
 * 它是「网站滚动条统一成 4px」的唯一实现，与悬浮球无关。
 */
export const SCROLLBAR_CSS = `
::-webkit-scrollbar {
  width: 4px !important;
  height: 4px !important;
}
::-webkit-scrollbar-track {
  background: transparent !important;
}
::-webkit-scrollbar-thumb {
  background: rgba(91, 140, 255, 0.45) !important;
  border-radius: 4px !important;
  transition: all 0.2s ease !important;
}
::-webkit-scrollbar-thumb:hover {
  background: #5b8cff !important;
  box-shadow: 0 0 6px rgba(91, 140, 255, 0.8) !important;
}
::-webkit-scrollbar-corner {
  background: transparent !important;
}
`;
