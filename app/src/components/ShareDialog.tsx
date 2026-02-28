import { useState } from 'react';
import { X, MessageCircle, Send, Sparkles, Brain, Bot, Share2, Camera, Image as ImageIcon } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SHARE_OPTIONS, type ShareOption } from '@/hooks/useNativeShare';

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  fileName: string;
  fileType: 'image' | 'video';
  onShare: (option: ShareOption) => void;
}

const getIcon = (iconName: string) => {
  switch (iconName) {
    case 'instagram':
      return <Camera className="w-6 h-6" />;
    case 'whatsapp':
      return <MessageCircle className="w-6 h-6" />;
    case 'telegram':
      return <Send className="w-6 h-6" />;
    case 'openai':
      return <Sparkles className="w-6 h-6" />;
    case 'anthropic':
      return <Brain className="w-6 h-6" />;
    case 'google':
      return <Bot className="w-6 h-6" />;
    case 'share':
      return <Share2 className="w-6 h-6" />;
    default:
      return <ImageIcon className="w-6 h-6" />;
  }
};

const getOptionColor = (id: string): string => {
  switch (id) {
    case 'instagram-story':
    case 'instagram-post':
      return 'bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400';
    case 'whatsapp':
      return 'bg-green-500';
    case 'telegram':
      return 'bg-blue-500';
    case 'chatgpt':
      return 'bg-emerald-500';
    case 'claude':
      return 'bg-orange-500';
    case 'gemini':
      return 'bg-blue-600';
    default:
      return 'bg-gray-500';
  }
};

export function ShareDialog({ open, onClose, fileName, fileType, onShare }: ShareDialogProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);

  const handleShare = (option: ShareOption) => {
    setSelectedOption(option.id);
    onShare(option);
    setTimeout(() => {
      setSelectedOption(null);
      onClose();
    }, 300);
  };

  // Filter options based on file type
  const getFilteredOptions = () => {
    if (fileType === 'image') {
      // For images, show all options including Instagram
      return SHARE_OPTIONS;
    } else {
      // For videos, hide Instagram Story (only supports images)
      return SHARE_OPTIONS.filter(opt => opt.id !== 'instagram-story');
    }
  };

  const options = getFilteredOptions();

  // Separate social and AI platforms
  const socialOptions = options.filter(o => 
    ['instagram-story', 'instagram-post', 'whatsapp', 'telegram'].includes(o.id)
  );
  const aiOptions = options.filter(o => 
    ['chatgpt', 'claude', 'gemini'].includes(o.id)
  );
  const moreOption = options.find(o => o.id === 'more');

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm bg-white border-border-light p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-bg-light border-b border-border-light">
          <div>
            <h3 className="font-sans text-base font-semibold text-text-primary">Share Scrubbed Media</h3>
            <p className="font-sans text-xs text-text-secondary truncate max-w-[200px]">{fileName}</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Social Platforms */}
          <div>
            <p className="font-sans text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
              Social Platforms
            </p>
            <div className="grid grid-cols-4 gap-3">
              {socialOptions.map((option) => (
                <button
                  key={option.id}
                  onClick={() => handleShare(option)}
                  disabled={selectedOption === option.id}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl transition-all ${
                    selectedOption === option.id 
                      ? 'scale-95 opacity-70' 
                      : 'hover:bg-bg-light active:scale-95'
                  }`}
                >
                  <div className={`w-12 h-12 rounded-xl ${getOptionColor(option.id)} flex items-center justify-center text-white shadow-lg`}>
                    {getIcon(option.icon)}
                  </div>
                  <span className="font-sans text-[10px] text-text-primary text-center leading-tight">
                    {option.name}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* AI Platforms */}
          <div>
            <p className="font-sans text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
              AI Platforms
            </p>
            <div className="grid grid-cols-4 gap-3">
              {aiOptions.map((option) => (
                <button
                  key={option.id}
                  onClick={() => handleShare(option)}
                  disabled={selectedOption === option.id}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl transition-all ${
                    selectedOption === option.id 
                      ? 'scale-95 opacity-70' 
                      : 'hover:bg-bg-light active:scale-95'
                  }`}
                >
                  <div className={`w-12 h-12 rounded-xl ${getOptionColor(option.id)} flex items-center justify-center text-white shadow-lg`}>
                    {getIcon(option.icon)}
                  </div>
                  <span className="font-sans text-[10px] text-text-primary text-center leading-tight">
                    {option.name}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* More Options */}
          {moreOption && (
            <button
              onClick={() => handleShare(moreOption)}
              className="w-full flex items-center gap-3 p-3 rounded-xl bg-bg-light hover:bg-border-light transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-gray-400 flex items-center justify-center text-white">
                <Share2 className="w-5 h-5" />
              </div>
              <span className="font-sans text-sm font-medium text-text-primary">{moreOption.name}</span>
            </button>
          )}
        </div>

        {/* Footer info */}
        <div className="px-4 py-3 bg-bg-light border-t border-border-light">
          <p className="font-sans text-[10px] text-text-secondary text-center">
            Metadata has been removed. Your privacy is protected.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
