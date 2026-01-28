import React, { useState, useRef } from 'react';
import { Account } from '@/types/account';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, Trash2, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { enUS, zhCN, ru } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface AccountCardProps {
  account: Account;
  isCurrent: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  isSwitching?: boolean;
  isDeleting?: boolean;
}

export const AccountCard: React.FC<AccountCardProps> = ({
  account,
  isCurrent,
  onSwitch,
  onDelete,
  isSwitching,
  isDeleting,
}) => {
  const { t, i18n } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState('');
  const [glarePosition, setGlarePosition] = useState({ x: 50, y: 50 });

  const initials = account.name
    ? account.name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
    : account.email[0].toUpperCase();

  // 处理鼠标移动，计算 3D 旋转角度
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;

    const rect = cardRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // 计算鼠标相对于卡片中心的位置 (-1 到 1)
    const relativeX = (e.clientX - centerX) / (rect.width / 2);
    const relativeY = (e.clientY - centerY) / (rect.height / 2);

    // 最大旋转角度
    const maxRotation = 15;
    const rotateX = -relativeY * maxRotation; // 上下倾斜
    const rotateY = relativeX * maxRotation; // 左右倾斜

    setTransform(
      `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`,
    );

    // 更新光泽位置
    setGlarePosition({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    });
  };

  // 鼠标离开时重置
  const handleMouseLeave = () => {
    setTransform('perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)');
    setGlarePosition({ x: 50, y: 50 });
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        transform,
        transformStyle: 'preserve-3d',
        transition: transform ? 'transform 0.1s ease-out' : 'transform 0.5s ease-out',
      }}
      className="relative"
    >
      {/* 光泽效果层 */}
      <div
        className="pointer-events-none absolute inset-0 z-10 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(circle at ${glarePosition.x}% ${glarePosition.y}%, rgba(255,255,255,0.15) 0%, transparent 60%)`,
          opacity: transform ? 0.6 : 0,
        }}
      />

      <Card
        className={cn(
          'relative overflow-hidden transition-all duration-200',
          'hover:shadow-primary/10 hover:shadow-xl',
          isCurrent ? 'border-primary/50 bg-primary/5' : 'hover:border-primary/20 cursor-pointer',
          (isSwitching || isDeleting) && 'pointer-events-none opacity-60',
        )}
        onClick={() => !isCurrent && !isSwitching && !isDeleting && onSwitch(account.id)}
      >
        <CardContent className="flex items-center justify-between p-4">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <Avatar className={cn('h-10 w-10', isCurrent && 'ring-primary ring-2 ring-offset-2')}>
              <AvatarImage src={account.avatar_url} />
              <AvatarFallback className={isCurrent ? 'bg-primary text-primary-foreground' : ''}>
                {initials}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <h4 className="truncate leading-none font-semibold">{account.name}</h4>
                {isCurrent && (
                  <Badge variant="default" className="h-5 flex-none px-1.5 text-[10px]">
                    {t('account.current')}
                  </Badge>
                )}
                {isSwitching && (
                  <RefreshCw className="text-muted-foreground h-3 w-3 flex-none animate-spin" />
                )}
              </div>
              <p className="text-muted-foreground truncate text-sm">{account.email}</p>
              <p className="text-muted-foreground/60 truncate text-xs">
                {t('account.lastUsed', {
                  time: formatDistanceToNow(new Date(account.last_used), {
                    addSuffix: true,
                    locale: { en: enUS, 'zh-CN': zhCN, ru: ru }[i18n.language] || enUS,
                  }),
                })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(account.id);
                  }}
                  disabled={isDeleting}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('action.deleteBackup')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
