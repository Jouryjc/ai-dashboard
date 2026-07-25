/**
 * 共享卡片组件总出口 —— chat agent（对话流）与 exec-panel agent（卡点行动区）从这里导入。
 * 用法：
 *   <ClarificationCard :message="msg" @answer="answers => chat.answerClarification(msg.id, answers)" />
 *   <ProblemCard :message="msg" @choose="chat.chooseOption" @custom="t => chat.send(t)" />
 *   <OptionButton :option="opt" @select="chat.chooseOption" />   <!-- 右栏行动区单按钮复用 -->
 */
export { default as OptionButton } from './OptionButton.vue'
export { default as ClarificationCard } from './ClarificationCard.vue'
export { default as ProblemCard } from './ProblemCard.vue'
