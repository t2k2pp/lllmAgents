// Vertical Scrolling Shooter Game

class SpaceShooter {
    constructor() {
        // Canvas setup
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Game constants
        this.WIDTH = this.canvas.width;
        this.HEIGHT = this.canvas.height;
        
        // Player settings
        this.playerWidth = 40;
        this.playerHeight = 40;
        this.playerSpeed = 5;
        
        // Bullet settings
        this.bulletSpeed = 10;
        this.bulletSize = 4;
        this.fireCooldown = 150;
        
        // Enemy settings
        this.enemySpeed = 2;
        this.enemySpawnRate = 1500;
        
        // Star field for scrolling effect
        this.stars = [];
        
        // Game state
        this.player = { x: 0, y: 0, lives: 3, invincible: false, invincibleTimer: 0 };
        this.bullets = [];
        this.enemies = [];
        this.explosions = [];
        this.score = 0;
        this.highScore = 0;
        this.wave = 1;
        this.gameOver = false;
        this.paused = false;
        this.gameStarted = false;
        
        // Timing
        this.lastFireTime = 0;
        this.lastEnemySpawn = 0;
        this.lastUpdate = 0;
        
        // Key states
        this.keys = {};
        
        // Bind methods
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleKeyUp = this.handleKeyUp.bind(this);
        this.update = this.update.bind(this);
        this.start = this.start.bind(this);
        
        // Event listeners
        document.addEventListener('keydown', this.handleKeyDown);
        document.addEventListener('keyup', this.handleKeyUp);
        document.getElementById('start-btn').addEventListener('click', this.start);
        
        // Initialize
        this.initStars();
        this.loadHighScore();
        this.draw();
    }
    
    initStars() {
        for (let i = 0; i < 100; i++) {
            this.stars.push({
                x: Math.random() * this.WIDTH,
                y: Math.random() * this.HEIGHT,
                size: Math.random() * 2 + 1,
                speed: Math.random() * 2 + 1
            });
        }
    }
    
    loadHighScore() {
        const saved = localStorage.getItem('spaceShooterHighScore');
        if (saved) {
            this.highScore = parseInt(saved);
            document.getElementById('high-score').textContent = this.highScore;
        }
    }
    
    saveHighScore() {
        if (this.score > this.highScore) {
            this.highScore = this.score;
            localStorage.setItem('spaceShooterHighScore', this.highScore);
            document.getElementById('high-score').textContent = this.highScore;
        }
    }
    
    start() {
        if (this.gameStarted && !this.gameOver) {
            // Pause/Resume toggle
            this.paused = !this.paused;
            document.getElementById('start-btn').textContent = this.paused ? 'Resume' : 'Pause';
            if (!this.paused) {
                this.lastUpdate = performance.now();
                requestAnimationFrame(this.update);
            }
            return;
        }
        
        // Reset game state
        this.gameStarted = true;
        this.gameOver = false;
        this.paused = false;
        this.score = 0;
        this.wave = 1;
        this.player = {
            x: this.WIDTH / 2 - this.playerWidth / 2,
            y: this.HEIGHT - 60,
            lives: 3,
            invincible: false,
            invincibleTimer: 0
        };
        this.bullets = [];
        this.enemies = [];
        this.explosions = [];
        this.enemySpawnRate = 1500;
        
        this.updateUI();
        document.getElementById('start-btn').textContent = 'Pause';
        
        this.lastUpdate = performance.now();
        requestAnimationFrame(this.update);
    }
    
    update(time = 0) {
        if (this.paused || this.gameOver) return;
        
        const deltaTime = time - this.lastUpdate;
        this.lastUpdate = time;
        
        this.updatePlayer();
        this.updateBullets(deltaTime);
        this.updateEnemies(deltaTime);
        this.updateExplosions(deltaTime);
        this.spawnEnemies(time);
        this.updateStars();
        this.checkCollisions();
        
        this.draw();
        
        if (!this.gameOver) {
            requestAnimationFrame(this.update);
        }
    }
    
    updatePlayer() {
        // Movement
        if (this.keys['ArrowLeft'] && this.player.x > 0) {
            this.player.x -= this.playerSpeed;
        }
        if (this.keys['ArrowRight'] && this.player.x < this.WIDTH - this.playerWidth) {
            this.player.x += this.playerSpeed;
        }
        if (this.keys['ArrowUp'] && this.player.y > 0) {
            this.player.y -= this.playerSpeed;
        }
        if (this.keys['ArrowDown'] && this.player.y < this.HEIGHT - this.playerHeight) {
            this.player.y += this.playerSpeed;
        }
        
        // Shooting
        if (this.keys['z'] || this.keys['Z']) {
            const now = performance.now();
            if (now - this.lastFireTime > this.fireCooldown) {
                this.fireBullet();
                this.lastFireTime = now;
            }
        }
        
        // Invincibility timer
        if (this.player.invincible) {
            this.player.invincibleTimer -= 1000 / 60;
            if (this.player.invincibleTimer <= 0) {
                this.player.invincible = false;
            }
        }
    }
    
    fireBullet() {
        this.bullets.push({
            x: this.player.x + this.playerWidth / 2 - this.bulletSize / 2,
            y: this.player.y,
            width: this.bulletSize,
            height: 10
        });
    }
    
    updateBullets(deltaTime) {
        this.bullets = this.bullets.filter(bullet => {
            bullet.y -= this.bulletSpeed;
            return bullet.y > -bullet.height;
        });
    }
    
    spawnEnemies(time) {
        if (time - this.lastEnemySpawn > this.enemySpawnRate) {
            this.lastEnemySpawn = time;
            
            const enemyTypes = ['basic', 'fast', 'tank'];
            const type = enemyTypes[Math.floor(Math.random() * Math.min(this.wave, enemyTypes.length))];
            
            let enemy;
            switch (type) {
                case 'basic':
                    enemy = {
                        x: Math.random() * (this.WIDTH - 40),
                        y: -40,
                        width: 35,
                        height: 35,
                        speed: this.enemySpeed + this.wave * 0.2,
                        health: 1,
                        type: 'basic',
                        color: '#ff4444'
                    };
                    break;
                case 'fast':
                    enemy = {
                        x: Math.random() * (this.WIDTH - 30),
                        y: -30,
                        width: 30,
                        height: 30,
                        speed: this.enemySpeed * 1.5 + this.wave * 0.3,
                        health: 1,
                        type: 'fast',
                        color: '#ff8800'
                    };
                    break;
                case 'tank':
                    enemy = {
                        x: Math.random() * (this.WIDTH - 50),
                        y: -50,
                        width: 50,
                        height: 40,
                        speed: this.enemySpeed * 0.5,
                        health: 3,
                        type: 'tank',
                        color: '#ff00ff'
                    };
                    break;
                default:
                    enemy = null;
            }
            
            if (enemy) {
                this.enemies.push(enemy);
            }
        }
    }
    
    updateEnemies(deltaTime) {
        this.enemies = this.enemies.filter(enemy => {
            enemy.y += enemy.speed;
            return enemy.y < this.HEIGHT;
        });
    }
    
    updateExplosions(deltaTime) {
        this.explosions = this.explosions.filter(exp => {
            exp.duration -= deltaTime;
            exp.radius += 0.5;
            exp.alpha -= 0.02;
            return exp.duration > 0 && exp.alpha > 0;
        });
    }
    
    checkCollisions() {
        // Bullets vs Enemies
        this.bullets.forEach((bullet, bulletIndex) => {
            this.enemies.forEach((enemy, enemyIndex) => {
                if (this.rectIntersect(
                    bullet.x, bullet.y, bullet.width, bullet.height,
                    enemy.x, enemy.y, enemy.width, enemy.height
                )) {
                    // Hit enemy
                    enemy.health--;
                    this.bullets.splice(bulletIndex, 1);
                    
                    if (enemy.health <= 0) {
                        this.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2, enemy.color);
                        this.enemies.splice(enemyIndex, 1);
                        this.addScore(this.getEnemyScore(enemy));
                    }
                }
            });
        });
        
        // Player vs Enemies
        if (!this.player.invincible) {
            this.enemies.forEach((enemy, index) => {
                if (this.rectIntersect(
                    this.player.x, this.player.y, this.playerWidth, this.playerHeight,
                    enemy.x, enemy.y, enemy.width, enemy.height
                )) {
                    this.createExplosion(this.player.x + this.playerWidth/2, this.player.y + this.playerHeight/2, '#00ff00');
                    this.enemies.splice(index, 1);
                    this.playerHit();
                }
            });
        }
    }
    
    rectIntersect(x1, y1, w1, h1, x2, y2, w2, h2) {
        return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
    }
    
    getEnemyScore(enemy) {
        switch (enemy.type) {
            case 'fast': return 200;
            case 'tank': return 300;
            default: return 100;
        }
    }
    
    createExplosion(x, y, color) {
        this.explosions.push({
            x: x,
            y: y,
            radius: 0,
            color: color,
            alpha: 1,
            duration: 300
        });
    }
    
    playerHit() {
        this.player.lives--;
        this.player.invincible = true;
        this.player.invincibleTimer = 2000;
        
        if (this.player.lives <= 0) {
            this.gameOver = true;
            this.saveHighScore();
            this.draw();
            this.showGameOver();
        } else {
            this.updateUI();
        }
    }
    
    addScore(points) {
        this.score += points;
        
        // Wave progression
        const newWave = Math.floor(this.score / 2000) + 1;
        if (newWave > this.wave) {
            this.wave = newWave;
            this.enemySpawnRate = Math.max(500, 1500 - this.wave * 100);
            this.updateUI();
        }
        
        this.updateUI();
    }
    
    updateUI() {
        document.getElementById('score').textContent = this.score;
        document.getElementById('lives').textContent = '♥'.repeat(this.player.lives);
        document.getElementById('wave').textContent = this.wave;
    }
    
    showGameOver() {
        setTimeout(() => {
            alert('Game Over!\nScore: ' + this.score + '\nHigh Score: ' + this.highScore);
            document.getElementById('start-btn').textContent = 'Start Game';
        }, 100);
    }
    
    updateStars() {
        this.stars.forEach(star => {
            star.y += star.speed;
            if (star.y > this.HEIGHT) {
                star.y = 0;
                star.x = Math.random() * this.WIDTH;
            }
        });
    }
    
    draw() {
        // Clear canvas with gradient background
        const gradient = this.ctx.createLinearGradient(0, 0, 0, this.HEIGHT);
        gradient.addColorStop(0, '#0a0a1a');
        gradient.addColorStop(1, '#1a0a2e');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, this.WIDTH, this.HEIGHT);
        
        // Draw stars
        this.ctx.fillStyle = '#ffffff';
        this.stars.forEach(star => {
            this.ctx.globalAlpha = 0.6;
            this.ctx.beginPath();
            this.ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
            this.ctx.fill();
        });
        this.ctx.globalAlpha = 1;
        
        // Draw explosions
        this.explosions.forEach(exp => {
            this.ctx.fillStyle = exp.color;
            this.ctx.globalAlpha = exp.alpha;
            this.ctx.beginPath();
            this.ctx.arc(exp.x, exp.y, exp.radius, 0, Math.PI * 2);
            this.ctx.fill();
        });
        this.ctx.globalAlpha = 1;
        
        // Draw bullets
        this.ctx.fillStyle = '#00ffff';
        this.ctx.shadowColor = '#00ffff';
        this.ctx.shadowBlur = 10;
        this.bullets.forEach(bullet => {
            this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
        });
        this.ctx.shadowBlur = 0;
        
        // Draw enemies
        this.enemies.forEach(enemy => {
            this.drawEnemy(enemy);
        });
        
        // Draw player
        if (!this.player.invincible || Math.floor(performance.now() / 100) % 2 === 0) {
            this.drawPlayer();
        }
        
        // Game Over overlay
        if (this.gameOver) {
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            this.ctx.fillRect(0, 0, this.WIDTH, this.HEIGHT);
            
            this.ctx.fillStyle = '#ff00ff';
            this.ctx.font = 'bold 48px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('GAME OVER', this.WIDTH / 2, this.HEIGHT / 2 - 20);
            
            this.ctx.fillStyle = '#ffffff';
            this.ctx.font = '24px Arial';
            this.ctx.fillText('Score: ' + this.score, this.WIDTH / 2, this.HEIGHT / 2 + 20);
            this.ctx.fillText('High Score: ' + this.highScore, this.WIDTH / 2, this.HEIGHT / 2 + 50);
        }
        
        // Pause overlay
        if (this.paused && !this.gameOver) {
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            this.ctx.fillRect(0, 0, this.WIDTH, this.HEIGHT);
            
            this.ctx.fillStyle = '#00ffff';
            this.ctx.font = 'bold 48px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('PAUSED', this.WIDTH / 2, this.HEIGHT / 2);
        }
    }
    
    drawPlayer() {
        const x = this.player.x;
        const y = this.player.y;
        
        // Ship body
        this.ctx.fillStyle = '#00ff00';
        this.ctx.beginPath();
        this.ctx.moveTo(x + this.playerWidth / 2, y);
        this.ctx.lineTo(x + this.playerWidth, y + this.playerHeight);
        this.ctx.lineTo(x + this.playerWidth / 2, y + this.playerHeight - 10);
        this.ctx.lineTo(x, y + this.playerHeight);
        this.ctx.closePath();
        this.ctx.fill();
        
        // Cockpit
        this.ctx.fillStyle = '#88ff88';
        this.ctx.beginPath();
        this.ctx.arc(x + this.playerWidth / 2, y + this.playerHeight / 2, 8, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Engine glow
        this.ctx.fillStyle = '#ff6600';
        this.ctx.shadowColor = '#ff6600';
        this.ctx.shadowBlur = 15;
        this.ctx.beginPath();
        this.ctx.arc(x + this.playerWidth / 2, y + this.playerHeight + 5, 5, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.shadowBlur = 0;
    }
    
    drawEnemy(enemy) {
        const x = enemy.x;
        const y = enemy.y;
        
        this.ctx.fillStyle = enemy.color;
        
        switch (enemy.type) {
            case 'basic':
                // Diamond shape
                this.ctx.beginPath();
                this.ctx.moveTo(x + enemy.width / 2, y);
                this.ctx.lineTo(x + enemy.width, y + enemy.height / 2);
                this.ctx.lineTo(x + enemy.width / 2, y + enemy.height);
                this.ctx.lineTo(x, y + enemy.height / 2);
                this.ctx.closePath();
                this.ctx.fill();
                break;
                
            case 'fast':
                // Arrow shape pointing down
                this.ctx.beginPath();
                this.ctx.moveTo(x + enemy.width / 2, y + enemy.height);
                this.ctx.lineTo(x + enemy.width, y);
                this.ctx.lineTo(x, y);
                this.ctx.closePath();
                this.ctx.fill();
                break;
                
            case 'tank':
                // Box with spikes
                this.ctx.fillRect(x, y, enemy.width, enemy.height);
                this.ctx.fillStyle = '#aa00aa';
                this.ctx.fillRect(x + 10, y + 10, enemy.width - 20, enemy.height - 20);
                break;
                
            default:
                this.ctx.fillRect(x, y, enemy.width, enemy.height);
        }
    }
    
    handleKeyDown(event) {
        this.keys[event.key] = true;
        
        if (event.key === 'p' || event.key === 'P') {
            if (this.gameStarted && !this.gameOver) {
                this.paused = !this.paused;
                document.getElementById('start-btn').textContent = this.paused ? 'Resume' : 'Pause';
                if (!this.paused) {
                    this.lastUpdate = performance.now();
                    requestAnimationFrame(this.update);
                }
            }
        }
        
        if (event.key === 'x' || event.key === 'X') {
            if (this.gameStarted && !this.gameOver && !this.paused) {
                this.fireBomb();
            }
        }
    }
    
    handleKeyUp(event) {
        this.keys[event.key] = false;
    }
    
    fireBomb() {
        // Bomb destroys all enemies on screen
        this.enemies.forEach(enemy => {
            this.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2, '#ffff00');
            this.addScore(this.getEnemyScore(enemy));
        });
        this.enemies = [];
        
        // Screen shake effect
        this.canvas.style.transform = 'translate(5px, 5px)';
        setTimeout(() => {
            this.canvas.style.transform = 'translate(-5px, -5px)';
            setTimeout(() => {
                this.canvas.style.transform = 'translate(0, 0)';
            }, 50);
        }, 50);
    }
}

// Initialize game when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.game = new SpaceShooter();
});
