import { useId, useState } from 'react';
import { Check, CircleHelp, TriangleAlert } from 'lucide-react';
import type { Pending } from '../../../shared/protocol';
import { DiffView } from './DiffView';
import { editsOf, lineCount, textOf } from './content';
import './components.css';

export interface PermissionCardProps {
  pending: Pending[];
  respond: (requestId: string, data: Record<string, any>) => boolean | void;
}
interface Question {
  question: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; preview?: string }[];
}

function ToolPreview({ request }: { request: Pending }) {
  const { toolName, input } = request;
  const path = input.file_path ?? input.path ?? '';
  if (toolName === 'Bash')
    return (
      <>
        <pre className="cc-command">{input.command}</pre>
        {input.description && <p className="cc-card-description">{input.description}</p>}
      </>
    );
  if (toolName === 'Edit' || toolName === 'MultiEdit')
    return (
      <>
        <div className="cc-card-path">{path}</div>
        <div className="cc-permission-diff">
          {editsOf(input).map((edit, index) => (
            <DiffView key={index} {...edit} />
          ))}
        </div>
      </>
    );
  if (toolName === 'Write') {
    const content = String(input.content ?? '');
    return (
      <>
        <div className="cc-card-path">{path}</div>
        <p className="cc-card-description">
          {input.overwrite || input.file_exists ? '覆盖文件' : '新建文件'}，{lineCount(content)} 行
        </p>
        <pre className="cc-command">{content.split('\n').slice(0, 20).join('\n')}</pre>
      </>
    );
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch')
    return <pre className="cc-command">{input.url ?? input.query}</pre>;
  return <pre className="cc-command cc-preview-scroll">{textOf(input)}</pre>;
}

function ruleLabel(suggestions: any[]): string {
  return suggestions
    .flatMap((suggestion) =>
      Array.isArray(suggestion.rules)
        ? suggestion.rules.map(
            (rule: any) => `${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ''}`,
          )
        : [textOf(suggestion)],
    )
    .join(', ');
}

function Approval({
  request,
  count,
  respond,
}: {
  request: Pending;
  count: number;
  respond: PermissionCardProps['respond'];
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const title = useId();
  const reply = (data: Record<string, any>) => {
    if (!submitted && respond(request.requestId, data) !== false) setSubmitted(true);
  };
  const deny = () => reply({ behavior: 'deny', message: reason });
  return (
    <section
      className="cc-card cc-approval"
      aria-labelledby={title}
      onKeyDown={(event) => {
        if (rejecting && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          deny();
        }
      }}
    >
      <div className="cc-card-head">
        <TriangleAlert size={16} strokeWidth={1.75} className="cc-warn" />
        <span className="cc-card-title" id={title}>
          需要确认
        </span>
        <span className="cc-tool-chip">{request.toolName}</span>
        <span className="cc-card-index">1 / {count}</span>
      </div>
      <div className="cc-card-body">
        <ToolPreview request={request} />
        {rejecting && (
          <textarea
            autoFocus
            className="cc-reject-reason"
            placeholder="告诉 Claude 为什么拒绝、应该怎么做（可选）"
            aria-label="告诉 Claude 为什么拒绝、应该怎么做（可选）"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </div>
      <div className="cc-card-foot">
        {rejecting ? (
          <>
            <button
              type="button"
              className="cc-button cc-ghost"
              disabled={submitted}
              onClick={() => setRejecting(false)}
            >
              取消
            </button>
            <button type="button" className="cc-button cc-danger-button" disabled={submitted} onClick={deny}>
              确认拒绝
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="cc-button cc-danger-text"
              disabled={submitted}
              onClick={() => setRejecting(true)}
            >
              拒绝
            </button>
            {!!request.suggestions?.length && (
              <button
                type="button"
                className="cc-button cc-secondary"
                disabled={submitted}
                onClick={() =>
                  reply({
                    behavior: 'allow',
                    updatedInput: request.input,
                    updatedPermissions: request.suggestions,
                    remember: true,
                  })
                }
              >
                始终允许
              </button>
            )}
            <button
              type="button"
              className="cc-button cc-primary"
              disabled={submitted}
              onClick={() => reply({ behavior: 'allow', updatedInput: request.input })}
            >
              允许
            </button>
          </>
        )}
      </div>
      {!rejecting && !!request.suggestions?.length && (
        <div className="cc-rule-hint">
          始终允许将添加规则 <code>{ruleLabel(request.suggestions)}</code>
        </div>
      )}
    </section>
  );
}

function Questions({ request, respond }: { request: Pending; respond: PermissionCardProps['respond'] }) {
  const questions: Question[] = Array.isArray(request.input.questions) ? request.input.questions : [];
  const [index, setIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const title = useId();
  const question = questions[index];
  const selected = selections[index] ?? [];
  const answer = custom[index]?.trim() || selected.join(', ');
  const reply = (data: Record<string, any>) => {
    if (!submitted && respond(request.requestId, data) !== false) setSubmitted(true);
  };
  const advance = () => {
    if (!answer) return;
    if (index < questions.length - 1) setIndex(index + 1);
    else
      reply({
        behavior: 'allow',
        updatedInput: {
          ...request.input,
          questions,
          answers: Object.fromEntries(
            questions.map((item, at) => [
              item.question,
              custom[at]?.trim() || (selections[at] ?? []).join(', '),
            ]),
          ),
        },
      });
  };
  return (
    <section className="cc-card cc-question" aria-labelledby={title}>
      <div className="cc-card-head">
        <CircleHelp size={16} strokeWidth={1.75} className="cc-accent" />
        <span className="cc-card-title" id={title}>
          Claude 提问
        </span>
        <span className="cc-card-index">
          {questions.length ? index + 1 : 0} / {questions.length}
        </span>
      </div>
      {question && (
        <div className="cc-card-body" key={index}>
          <div className="cc-question-text" id={`${title}-question`}>
            {question.question}
          </div>
          <div
            className="cc-options"
            role={question.multiSelect ? 'group' : 'radiogroup'}
            aria-labelledby={`${title}-question`}
          >
            {(question.options ?? []).map((option) => (
              <button
                type="button"
                key={option.label}
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected.includes(option.label)}
                disabled={submitted}
                className={`cc-option${question.multiSelect ? ' cc-option-multi' : ''}${selected.includes(option.label) ? ' cc-selected' : ''}`}
                onClick={() => {
                  setCustom({ ...custom, [index]: '' });
                  setSelections({
                    ...selections,
                    [index]: question.multiSelect
                      ? selected.includes(option.label)
                        ? selected.filter((label) => label !== option.label)
                        : [...selected, option.label]
                      : [option.label],
                  });
                }}
              >
                <span className="cc-option-mark">
                  {question.multiSelect && selected.includes(option.label) && (
                    <Check size={14} strokeWidth={1.75} />
                  )}
                </span>
                <span className="cc-option-content">
                  <span className="cc-option-label">{option.label}</span>
                  {option.description && <span className="cc-option-description">{option.description}</span>}
                  {option.preview && <pre className="cc-command cc-option-preview">{option.preview}</pre>}
                </span>
              </button>
            ))}
          </div>
          <input
            className="cc-input"
            aria-label="其他，直接输入…"
            placeholder="其他，直接输入…"
            value={custom[index] ?? ''}
            disabled={submitted}
            onChange={(event) => {
              setCustom({ ...custom, [index]: event.target.value });
              if (event.target.value) setSelections({ ...selections, [index]: [] });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                advance();
              }
            }}
          />
        </div>
      )}
      <div className="cc-card-foot cc-question-foot">
        <button
          type="button"
          className="cc-button cc-ghost"
          disabled={submitted}
          onClick={() => reply({ behavior: 'deny' })}
        >
          不回答
        </button>
        <button
          type="button"
          className="cc-button cc-primary"
          disabled={!answer || submitted}
          onClick={advance}
        >
          {index < questions.length - 1 ? '下一题' : '提交'}
        </button>
      </div>
    </section>
  );
}

export function PermissionCard({ pending, respond }: PermissionCardProps) {
  const approvals = pending.filter((request) => request.toolName !== 'AskUserQuestion');
  const request = approvals[0] ?? pending[0];
  if (!request) return null;
  return request.toolName === 'AskUserQuestion' ? (
    <Questions key={request.requestId} request={request} respond={respond} />
  ) : (
    <Approval key={request.requestId} request={request} count={approvals.length} respond={respond} />
  );
}

export default PermissionCard;
