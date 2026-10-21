/** 程序化更新（setText、setEditorStateJson 等）的通用标记 */
export const PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic";

/**
 * 历史导航回填专用标记。
 * 此前 PromptHistoryPlugin 回填历史条目时使用通用 PROGRAMMATIC_UPDATE_TAG，
 * SlashCommandPlugin 的 update listener 无法区分"用户正在输入 slash 查询"与
 * "历史导航把含 / 的旧条目写回编辑器"，导致面板重新打开并以 COMMAND_PRIORITY_CRITICAL
 * 注册方向键处理器，将后续 ArrowUp/ArrowDown 全部吞掉，历史索引无法继续翻阅。
 * 使用独立标记后，SlashCommandPlugin 可精确跳过历史回填更新，不影响用户手输 / 时的正常面板行为。
 */
export const HISTORY_NAVIGATION_UPDATE_TAG = "zcode-history-navigation";

/**
 * 提示词库插入专用标记。
 * 提示词正文是纯文本，可能以 `;`、`@`、`/`、`$`、`#` 结尾；若把这次 update 当成用户输入，
 * 提示词面板、mention 面板和 slash 面板都可能立刻重新打开并吞掉后续按键。
 * 三个面板的 update listener 必须显式忽略该标记。
 */
export const PROMPT_LIBRARY_INSERT_UPDATE_TAG = "zcode-prompt-library-insert";
