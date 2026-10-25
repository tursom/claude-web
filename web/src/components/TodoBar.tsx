import { useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Circle, CircleCheck, ListChecks, LoaderCircle } from 'lucide-react';
import type { Message } from '../../../shared/protocol';
import { blocksOf, envelope, roleOf } from './content';
import './components.css';

export interface TodoBarProps {
  messages: Message[];
}
interface Todo {
  content: string;
  activeForm?: string;
  status: string;
}

export function TodoBar({ messages }: TodoBarProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const todos = useMemo(() => {
    let latest: Todo[] = [];
    for (const raw of messages) {
      const message = envelope(raw);
      if (message.parent_tool_use_id) continue;
      if (
        roleOf(message) === 'user' &&
        blocksOf(message).some((block) => block.type === 'text' || block.type === 'image') &&
        latest.length &&
        latest.every((todo) => todo.status === 'completed')
      )
        latest = [];
      for (const block of blocksOf(message)) {
        if (block.type === 'tool_use' && block.name === 'TodoWrite' && Array.isArray(block.input?.todos))
          latest = block.input.todos;
      }
    }
    return latest;
  }, [messages]);
  if (!todos.length) return null;
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress');
  return (
    <section className="cc-todo">
      <button
        type="button"
        className="cc-todo-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ListChecks size={16} strokeWidth={1.75} />
        <b>
          任务 {completed}/{todos.length}
        </b>
        <span className="cc-ellipsis cc-grow">
          {completed === todos.length
            ? '· 已全部完成'
            : current
              ? `当前：${current.activeForm || current.content}`
              : ''}
        </span>
        {open ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronUp size={16} strokeWidth={1.75} />}
      </button>
      {open && (
        <div className="cc-todo-list" id={id}>
          {todos.map((todo, index) => (
            <div className={`cc-todo-item cc-todo-${todo.status}`} key={index}>
              {todo.status === 'completed' ? (
                <CircleCheck size={16} strokeWidth={1.75} />
              ) : todo.status === 'in_progress' ? (
                <LoaderCircle size={16} strokeWidth={1.75} className="cc-spin" />
              ) : (
                <Circle size={16} strokeWidth={1.75} />
              )}
              <span>{todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default TodoBar;
