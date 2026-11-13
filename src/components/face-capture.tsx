import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Loader2, ScanFace } from 'lucide-react';
import { faceGateway } from '@cloud-client';

type Action = '1' | '2';
type Challenge = { challenge: string; actions: [Action, Action]; expiresInSeconds: number };
type Phase = 'idle' | 'opening' | 'ready' | 'recording' | 'verifying';
const actionLabels: Record<Action, string> = { 1: '张嘴再闭合', 2: '闭眼再睁开' };

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('摄像头文件读取失败，请重拍。'));
    reader.readAsDataURL(blob);
  });
}

function referencePhoto(video: HTMLVideoElement): Promise<Blob> {
  const scale = Math.min(1, 480 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context || !canvas.width || !canvas.height) return Promise.reject(new Error('摄像头画面未就绪。'));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('参考画面生成失败，请重拍。')), 'image/jpeg', .82);
  });
}

function captureVideo(stream: MediaStream, mimeType: string, actions: [Action, Action], signal: AbortSignal, prompt: (message: string) => void) {
  return new Promise<Blob>((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 650_000 });
    const chunks: Blob[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    const cleanup = () => {
      timers.forEach(clearTimeout);
      signal.removeEventListener('abort', stop);
    };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { cleanup(); stop(); reject(new Error('摄像头录制中断，请重拍。')); };
    recorder.onstop = () => {
      cleanup();
      if (signal.aborted) reject(new DOMException('Capture stopped', 'AbortError'));
      else resolve(new Blob(chunks, { type: mimeType }));
    };
    if (signal.aborted) { reject(new DOMException('Capture stopped', 'AbortError')); return; }
    recorder.start();
    signal.addEventListener('abort', stop, { once: true });
    prompt('看向摄像头，保持正脸');
    timers.push(setTimeout(() => prompt(actionLabels[actions[0]]), 550));
    timers.push(setTimeout(() => prompt(actionLabels[actions[1]]), 2550));
    timers.push(setTimeout(stop, 4950));
  });
}

function cameraMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '浏览器没有允许摄像头。请检查地址栏的网站权限。';
  if (error instanceof DOMException && error.name === 'NotFoundError') return '没有找到摄像头，请确认已开启或连接。';
  if (error instanceof DOMException && error.name === 'NotReadableError') return '摄像头暂时无法读取，请检查设备或占用摄像头的应用。';
  return error instanceof Error ? error.message : '摄像头或核验未完成，请重试。';
}

export default function FaceCapture({ start, complete, enrollment = false, enabled = true }: {
  start: (signal: AbortSignal) => Promise<Challenge>;
  complete: (result: { ticket?: string; enrolled?: boolean }) => Promise<void>;
  enrollment?: boolean;
  enabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [actions, setActions] = useState<[Action, Action] | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const current = useRef<AbortController | null>(null);
  const challenge = useRef<Challenge | null>(null);
  const format = useRef('');
  const expiredAt = useRef(0);

  function releaseCamera() {
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }

  function cancel() {
    current.current?.abort();
    challenge.current = null;
    releaseCamera();
    setActions(null);
    setPhase('idle');
    setMessage('');
  }

  useEffect(() => {
    window.addEventListener('pagehide', cancel);
    return () => {
      window.removeEventListener('pagehide', cancel);
      current.current?.abort();
      releaseCamera();
    };
  }, []);

  async function open() {
    cancel();
    setError('');
    const run = new AbortController();
    current.current = run;
    setPhase('opening');
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 网页直接打开摄像头。');
      format.current = typeof MediaRecorder !== 'undefined'
        ? ['video/mp4;codecs=avc1.42001f', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || ''
        : '';
      if (!format.current) throw new Error('当前浏览器不支持 MP4 录制。请使用支持该格式的 Chrome 或 Edge，或用密码登录。');
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'user' }, width: { ideal: 480, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 20, max: 24 } }
      });
      if (run.signal.aborted || !video.current) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream.current = acquired;
      acquired.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        cancel();
        setError('摄像头已断开，请重试。');
      }, { once: true, signal: run.signal }));
      video.current.srcObject = acquired;
      await video.current.play();
      const next = await start(run.signal);
      if (run.signal.aborted) return;
      if (!next.challenge || !next.actions || !['1,2', '2,1'].includes(next.actions.join(','))) throw new Error('核验动作未返回，请重试。');
      challenge.current = next;
      expiredAt.current = Date.now() + next.expiresInSeconds * 1000;
      setActions(next.actions);
      setPhase('ready');
    } catch (e) {
      if (!run.signal.aborted) { cancel(); setError(cameraMessage(e)); }
    }
  }

  async function verify() {
    const run = current.current, selected = challenge.current, preview = video.current, camera = stream.current;
    if (!run || run.signal.aborted || !selected || !preview || !camera || phase !== 'ready') return;
    if (Date.now() + 5000 >= expiredAt.current) { cancel(); setError('本次核验已过期，请重新打开摄像头。'); return; }
    setPhase('recording');
    try {
      const photo = enrollment ? await referencePhoto(preview) : null;
      const recording = await captureVideo(camera, format.current, selected.actions, run.signal, setMessage);
      if (run.signal.aborted) return;
      releaseCamera();
      setPhase('verifying');
      setMessage('正在核验，请稍候…');
      const result = await faceGateway<{ ticket?: string; enrolled?: boolean }>({
        action: 'finish', challenge: selected.challenge, video: await base64(recording),
        ...(photo ? { photo: await base64(photo) } : {})
      }, run.signal);
      if (run.signal.aborted) return;
      await complete(result);
      cancel();
    } catch (e) {
      if (!run.signal.aborted) { cancel(); setError(cameraMessage(e)); }
    }
  }

  const previewing = phase === 'ready' || phase === 'recording' || phase === 'opening';
  return (
    <div className="face-capture">
      <div className="face-video" data-open={previewing}>
        <video ref={video} muted autoPlay playsInline aria-label="本机前置摄像头" aria-hidden={!previewing} />
        {!previewing && <Camera size={26} aria-hidden />}
      </div>
      {actions && phase === 'ready' && <p className="face-prompt">录制时按顺序完成 {actions.map(action => actionLabels[action]).join(' → ')}</p>}
      <p className="face-prompt" role="status">{phase === 'opening' ? '正在准备摄像头和核验动作…' : message}</p>
      {error && <p className="login-error" role="alert">{error}</p>}
      <div className="face-actions">
        {phase === 'idle'
          ? <button type="button" className="primary-button" onClick={open} disabled={!enabled}><Camera size={16} />打开前置摄像头</button>
          : <button type="button" className="secondary-button" onClick={cancel} disabled={phase === 'verifying'}><CameraOff size={16} />取消</button>}
        {phase === 'ready' && <button type="button" className="primary-button" onClick={verify}><ScanFace size={16} />开始录制并核验</button>}
        {(phase === 'recording' || phase === 'verifying') && <Loader2 className="spin" size={17} aria-hidden />}
      </div>
    </div>
  );
}
