import { X } from 'lucide-react';
import type { Message } from '../../../shared/protocol';
import { blocksOf, imageSource } from './content';
import './message-queue.css';

export function MessageQueue({
  messages,
  connected,
  cancel,
}: {
  messages: Message[];
  connected: boolean;
  cancel: (id: string) => void;
}) {
  if (!messages.length) return null;
  return (
    <section className="cw-message-queue" aria-label="待发送消息">
      <div className="cw-queue-title">排队中 · {messages.length}</div>
      <ol>
        {messages.map((message, index) => {
          const blocks = blocksOf(message);
          const text = blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          const images = blocks
            .filter((block) => block.type === 'image')
            .map(imageSource)
            .filter(Boolean);
          return (
            <li key={message.uuid}>
              <div className="cw-queue-content">
                {text && <div className="cw-queue-text">{text}</div>}
                {images.length > 0 && (
                  <div className="cw-queue-images">
                    {images.map((src, i) => (
                      <img key={i} src={src} alt={`排队附件 ${i + 1}`} />
                    ))}
                  </div>
                )}
                {!text && !images.length && <span>附件消息</span>}
              </div>
              <button
                type="button"
                disabled={!connected}
                onClick={() => cancel(message.uuid)}
                aria-label={`取消第 ${index + 1} 条排队消息`}
                title={connected ? '取消排队' : '连接恢复后可取消'}
              >
                <X size={16} />
                <span>取消</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
