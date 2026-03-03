---
name: cpp-coding-standards
description: C++ coding standards based on the C++ Core Guidelines (isocpp.github.io). Use when writing, reviewing, or refactoring C++ code to enforce modern, safe, and idiomatic practices.
origin: ECC
---

# C++コーディング規約（C++ Core Guidelines）

[C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines)に基づく、モダンC++（C++17/20/23）のための包括的なコーディング規約。型安全性、リソース安全性、イミュータビリティ、明確性を推進する。

## 使用する場面

- 新しいC++コード（クラス、関数、テンプレート）を書く時
- 既存のC++コードをレビューまたはリファクタリングする時
- C++プロジェクトでアーキテクチャ上の判断をする時
- C++コードベース全体で一貫したスタイルを推進する時
- 言語機能の選択時（例: `enum` vs `enum class`、生ポインタ vs スマートポインタ）

### 使用すべきでない場面

- C++以外のプロジェクト
- モダンC++機能を採用できないレガシーCコードベース
- 特定のガイドラインがハードウェア制約と矛盾する組み込み/ベアメタルコンテキスト（選択的に適用する）

## 横断的原則

これらのテーマはガイドライン全体で繰り返し登場し、基盤を形成する:

1. **あらゆる場所でRAII** (P.8, R.1, E.6, CP.20): リソースのライフタイムをオブジェクトのライフタイムにバインドする
2. **デフォルトでイミュータブル** (P.10, Con.1-5, ES.25): `const`/`constexpr`から始め、ミュータビリティは例外とする
3. **型安全性** (P.4, I.4, ES.46-49, Enum.3): 型システムを使ってコンパイル時にエラーを防ぐ
4. **意図を表現する** (P.3, F.1, NL.1-2, T.10): 名前、型、コンセプトで目的を伝える
5. **複雑性を最小化する** (F.2-3, ES.5, Per.4-5): シンプルなコードは正しいコード
6. **ポインタセマンティクスより値セマンティクス** (C.10, R.3-5, F.20, CP.31): 値での返却とスコープ付きオブジェクトを好む

## 哲学とインターフェース (P.*, I.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **P.1** | アイデアをコードで直接表現する |
| **P.3** | 意図を表現する |
| **P.4** | 理想的には、プログラムは静的に型安全であるべき |
| **P.5** | 実行時チェックよりコンパイル時チェックを好む |
| **P.8** | リソースをリークしない |
| **P.10** | ミュータブルデータよりイミュータブルデータを好む |
| **I.1** | インターフェースを明示的にする |
| **I.2** | 非constグローバル変数を避ける |
| **I.4** | インターフェースを正確かつ強く型付けする |
| **I.11** | 生ポインタまたは参照で所有権を移転しない |
| **I.23** | 関数の引数の数を少なく保つ |

### 推奨

```cpp
// P.10 + I.4: イミュータブルで強く型付けされたインターフェース
struct Temperature {
    double kelvin;
};

Temperature boil(const Temperature& water);
```

### 非推奨

```cpp
// 弱いインターフェース: 所有権が不明確、単位が不明確
double boil(double* temp);

// 非constグローバル変数
int g_counter = 0;  // I.2 違反
```

## 関数 (F.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **F.1** | 意味のある操作を慎重に名前付けされた関数としてパッケージする |
| **F.2** | 関数は1つの論理的な操作を実行すべき |
| **F.3** | 関数を短くシンプルに保つ |
| **F.4** | コンパイル時に評価可能であれば`constexpr`を宣言する |
| **F.6** | 関数がスローしない場合は`noexcept`を宣言する |
| **F.8** | 純粋関数を好む |
| **F.16** | "in"パラメータについて、コピーが安価な型は値で、それ以外は`const&`で渡す |
| **F.20** | "out"値には出力パラメータより戻り値を好む |
| **F.21** | 複数の"out"値を返すには構造体を返すことを好む |
| **F.43** | ローカルオブジェクトへのポインタまたは参照を返さない |

### パラメータの渡し方

```cpp
// F.16: 安価な型は値で、それ以外はconst&で
void print(int x);                           // 安価: 値渡し
void analyze(const std::string& data);       // 高価: const&で
void transform(std::string s);               // シンク: 値渡し（ムーブされる）

// F.20 + F.21: 出力パラメータではなく戻り値を使用
struct ParseResult {
    std::string token;
    int position;
};

ParseResult parse(std::string_view input);   // 良い: 構造体を返す

// 悪い: 出力パラメータ
void parse(std::string_view input,
           std::string& token, int& pos);    // これは避ける
```

### 純粋関数とconstexpr

```cpp
// F.4 + F.8: 純粋で、可能な限りconstexpr
constexpr int factorial(int n) noexcept {
    return (n <= 1) ? 1 : n * factorial(n - 1);
}

static_assert(factorial(5) == 120);
```

### アンチパターン

- 関数から`T&&`を返す (F.45)
- `va_arg` / Cスタイルの可変長引数を使用する (F.55)
- 他のスレッドに渡されるラムダで参照キャプチャする (F.53)
- ムーブセマンティクスを阻害する`const T`を返す (F.49)

## クラスとクラス階層 (C.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **C.2** | 不変条件がある場合は`class`を使用する。データメンバーが独立に変化する場合は`struct` |
| **C.9** | メンバーの露出を最小化する |
| **C.20** | デフォルト操作の定義を避けられるなら避ける（ゼロの法則） |
| **C.21** | コピー/ムーブ/デストラクタのいずれかを定義または`=delete`するなら、すべてを扱う（5の法則） |
| **C.35** | 基底クラスのデストラクタはpublic virtualまたはprotected非virtual |
| **C.41** | コンストラクタは完全に初期化されたオブジェクトを作成すべき |
| **C.46** | 単一引数コンストラクタを`explicit`で宣言する |
| **C.67** | ポリモーフィッククラスはpublic コピー/ムーブを抑制すべき |
| **C.128** | 仮想関数: `virtual`、`override`、`final`のいずれか1つのみを指定する |

### ゼロの法則

```cpp
// C.20: コンパイラに特殊メンバーを生成させる
struct Employee {
    std::string name;
    std::string department;
    int id;
    // デストラクタ、コピー/ムーブコンストラクタ、代入演算子は不要
};
```

### 5の法則

```cpp
// C.21: リソースを管理する必要がある場合、5つすべてを定義する
class Buffer {
public:
    explicit Buffer(std::size_t size)
        : data_(std::make_unique<char[]>(size)), size_(size) {}

    ~Buffer() = default;

    Buffer(const Buffer& other)
        : data_(std::make_unique<char[]>(other.size_)), size_(other.size_) {
        std::copy_n(other.data_.get(), size_, data_.get());
    }

    Buffer& operator=(const Buffer& other) {
        if (this != &other) {
            auto new_data = std::make_unique<char[]>(other.size_);
            std::copy_n(other.data_.get(), other.size_, new_data.get());
            data_ = std::move(new_data);
            size_ = other.size_;
        }
        return *this;
    }

    Buffer(Buffer&&) noexcept = default;
    Buffer& operator=(Buffer&&) noexcept = default;

private:
    std::unique_ptr<char[]> data_;
    std::size_t size_;
};
```

### クラス階層

```cpp
// C.35 + C.128: 仮想デストラクタ、overrideを使用
class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;  // C.121: 純粋インターフェース
};

class Circle : public Shape {
public:
    explicit Circle(double r) : radius_(r) {}
    double area() const override { return 3.14159 * radius_ * radius_; }

private:
    double radius_;
};
```

### アンチパターン

- コンストラクタ/デストラクタで仮想関数を呼び出す (C.82)
- 非トリビアル型に`memset`/`memcpy`を使用する (C.90)
- 仮想関数とオーバーライダーで異なるデフォルト引数を提供する (C.140)
- データメンバーを`const`または参照にする（ムーブ/コピーを抑制する） (C.12)

## リソース管理 (R.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **R.1** | RAIIを使用してリソースを自動的に管理する |
| **R.3** | 生ポインタ（`T*`）は非所有 |
| **R.5** | スコープ付きオブジェクトを好む。不必要にヒープ割り当てしない |
| **R.10** | `malloc()`/`free()`を避ける |
| **R.11** | `new`と`delete`の明示的な呼び出しを避ける |
| **R.20** | 所有権を表すために`unique_ptr`または`shared_ptr`を使用する |
| **R.21** | 所有権の共有が不要なら`shared_ptr`より`unique_ptr`を好む |
| **R.22** | `shared_ptr`の作成には`make_shared()`を使用する |

### スマートポインタの使用

```cpp
// R.11 + R.20 + R.21: スマートポインタによるRAII
auto widget = std::make_unique<Widget>("config");  // 唯一の所有権
auto cache  = std::make_shared<Cache>(1024);        // 共有所有権

// R.3: 生ポインタ = 非所有オブザーバー
void render(const Widget* w) {  // wを所有しない
    if (w) w->draw();
}

render(widget.get());
```

### RAIIパターン

```cpp
// R.1: リソース獲得は初期化
class FileHandle {
public:
    explicit FileHandle(const std::string& path)
        : handle_(std::fopen(path.c_str(), "r")) {
        if (!handle_) throw std::runtime_error("Failed to open: " + path);
    }

    ~FileHandle() {
        if (handle_) std::fclose(handle_);
    }

    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;
    FileHandle(FileHandle&& other) noexcept
        : handle_(std::exchange(other.handle_, nullptr)) {}
    FileHandle& operator=(FileHandle&& other) noexcept {
        if (this != &other) {
            if (handle_) std::fclose(handle_);
            handle_ = std::exchange(other.handle_, nullptr);
        }
        return *this;
    }

private:
    std::FILE* handle_;
};
```

### アンチパターン

- 裸の`new`/`delete` (R.11)
- C++コードでの`malloc()`/`free()` (R.10)
- 単一の式内での複数リソース確保 (R.13 -- 例外安全性の危険)
- `unique_ptr`で十分な場面での`shared_ptr` (R.21)

## 式と文 (ES.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **ES.5** | スコープを小さく保つ |
| **ES.20** | オブジェクトは必ず初期化する |
| **ES.23** | `{}`初期化構文を好む |
| **ES.25** | 変更する意図がない限りオブジェクトを`const`または`constexpr`で宣言する |
| **ES.28** | `const`変数の複雑な初期化にはラムダを使用する |
| **ES.45** | マジック定数を避ける。シンボリック定数を使用する |
| **ES.46** | ナローイング/損失のある算術変換を避ける |
| **ES.47** | `0`や`NULL`ではなく`nullptr`を使用する |
| **ES.48** | キャストを避ける |
| **ES.50** | `const`をキャストで除去しない |

### 初期化

```cpp
// ES.20 + ES.23 + ES.25: 必ず初期化、{}を好む、デフォルトはconst
const int max_retries{3};
const std::string name{"widget"};
const std::vector<int> primes{2, 3, 5, 7, 11};

// ES.28: 複雑なconst初期化にはラムダ
const auto config = [&] {
    Config c;
    c.timeout = std::chrono::seconds{30};
    c.retries = max_retries;
    c.verbose = debug_mode;
    return c;
}();
```

### アンチパターン

- 未初期化変数 (ES.20)
- ポインタとして`0`や`NULL`を使用 (ES.47 -- `nullptr`を使用)
- Cスタイルキャスト (ES.48 -- `static_cast`、`const_cast`等を使用)
- `const`をキャストで除去 (ES.50)
- 名前付き定数なしのマジックナンバー (ES.45)
- 符号付きと符号なし算術の混在 (ES.100)
- ネストされたスコープでの名前の再利用 (ES.12)

## エラーハンドリング (E.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **E.1** | 設計の早い段階でエラーハンドリング戦略を策定する |
| **E.2** | 関数が割り当てられたタスクを実行できないことを示すために例外をスローする |
| **E.6** | リークを防ぐためにRAIIを使用する |
| **E.12** | スローが不可能または許容できない場合は`noexcept`を使用する |
| **E.14** | 例外には目的に合わせて設計されたユーザー定義型を使用する |
| **E.15** | 値でスロー、参照でキャッチする |
| **E.16** | デストラクタ、解放、スワップは絶対に失敗してはならない |
| **E.17** | すべての関数ですべての例外をキャッチしようとしない |

### 例外階層

```cpp
// E.14 + E.15: カスタム例外型、値でスロー、参照でキャッチ
class AppError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class NetworkError : public AppError {
public:
    NetworkError(const std::string& msg, int code)
        : AppError(msg), status_code(code) {}
    int status_code;
};

void fetch_data(const std::string& url) {
    // E.2: 失敗を示すためにスロー
    throw NetworkError("connection refused", 503);
}

void run() {
    try {
        fetch_data("https://api.example.com");
    } catch (const NetworkError& e) {
        log_error(e.what(), e.status_code);
    } catch (const AppError& e) {
        log_error(e.what());
    }
    // E.17: ここですべてをキャッチしない -- 予期しないエラーは伝播させる
}
```

### アンチパターン

- `int`や文字列リテラルのような組み込み型をスローする (E.14)
- 値でキャッチする（スライシングのリスク） (E.15)
- エラーを黙って飲み込む空のcatchブロック
- フロー制御のために例外を使用する (E.3)
- `errno`のようなグローバル状態に基づくエラーハンドリング (E.28)

## 定数とイミュータビリティ (Con.*)

### 全ルール

| ルール | 要約 |
|--------|------|
| **Con.1** | デフォルトでオブジェクトをイミュータブルにする |
| **Con.2** | デフォルトでメンバー関数を`const`にする |
| **Con.3** | デフォルトで`const`へのポインタと参照を渡す |
| **Con.4** | コンストラクション後に変更されない値には`const`を使用する |
| **Con.5** | コンパイル時に計算可能な値には`constexpr`を使用する |

```cpp
// Con.1からCon.5: デフォルトでイミュータブル
class Sensor {
public:
    explicit Sensor(std::string id) : id_(std::move(id)) {}

    // Con.2: デフォルトでconstメンバー関数
    const std::string& id() const { return id_; }
    double last_reading() const { return reading_; }

    // ミューテーションが必要な場合のみ非const
    void record(double value) { reading_ = value; }

private:
    const std::string id_;  // Con.4: コンストラクション後に変更されない
    double reading_{0.0};
};

// Con.3: const参照で渡す
void display(const Sensor& s) {
    std::cout << s.id() << ": " << s.last_reading() << '\n';
}

// Con.5: コンパイル時定数
constexpr double PI = 3.14159265358979;
constexpr int MAX_SENSORS = 256;
```

## 並行性と並列性 (CP.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **CP.2** | データ競合を避ける |
| **CP.3** | 書き込み可能データの明示的な共有を最小化する |
| **CP.4** | スレッドではなくタスクの観点で考える |
| **CP.8** | 同期のために`volatile`を使用しない |
| **CP.20** | RAIIを使用する。素の`lock()`/`unlock()`は使用しない |
| **CP.21** | 複数のmutexの取得には`std::scoped_lock`を使用する |
| **CP.22** | ロック保持中に未知のコードを呼び出さない |
| **CP.42** | 条件なしにwaitしない |
| **CP.44** | `lock_guard`と`unique_lock`に名前を付けることを忘れない |
| **CP.100** | 本当に必要でない限りロックフリープログラミングを使用しない |

### 安全なロック

```cpp
// CP.20 + CP.44: RAIIロック、必ず名前付き
class ThreadSafeQueue {
public:
    void push(int value) {
        std::lock_guard<std::mutex> lock(mutex_);  // CP.44: 名前付き！
        queue_.push(value);
        cv_.notify_one();
    }

    int pop() {
        std::unique_lock<std::mutex> lock(mutex_);
        // CP.42: 必ず条件付きでwait
        cv_.wait(lock, [this] { return !queue_.empty(); });
        const int value = queue_.front();
        queue_.pop();
        return value;
    }

private:
    std::mutex mutex_;             // CP.50: mutexとそのデータを一緒に
    std::condition_variable cv_;
    std::queue<int> queue_;
};
```

### 複数のMutex

```cpp
// CP.21: 複数mutexにはstd::scoped_lock（デッドロックフリー）
void transfer(Account& from, Account& to, double amount) {
    std::scoped_lock lock(from.mutex_, to.mutex_);
    from.balance_ -= amount;
    to.balance_ += amount;
}
```

### アンチパターン

- 同期のための`volatile` (CP.8 -- ハードウェアI/O専用)
- スレッドのデタッチ (CP.26 -- ライフタイム管理がほぼ不可能になる)
- 無名のロックガード: `std::lock_guard<std::mutex>(m);` は即座に破棄される (CP.44)
- コールバック呼び出し中のロック保持 (CP.22 -- デッドロックのリスク)
- 深い専門知識なしのロックフリープログラミング (CP.100)

## テンプレートとジェネリックプログラミング (T.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **T.1** | テンプレートを使用して抽象化のレベルを上げる |
| **T.2** | テンプレートを使用して多くの引数型に対するアルゴリズムを表現する |
| **T.10** | すべてのテンプレート引数にコンセプトを指定する |
| **T.11** | 可能な限り標準コンセプトを使用する |
| **T.13** | シンプルなコンセプトには省略記法を好む |
| **T.43** | `typedef`より`using`を好む |
| **T.120** | 本当に必要な場合にのみテンプレートメタプログラミングを使用する |
| **T.144** | 関数テンプレートの特殊化はしない（代わりにオーバーロード） |

### コンセプト (C++20)

```cpp
#include <concepts>

// T.10 + T.11: 標準コンセプトでテンプレートを制約
template<std::integral T>
T gcd(T a, T b) {
    while (b != 0) {
        a = std::exchange(b, a % b);
    }
    return a;
}

// T.13: コンセプトの省略記法
void sort(std::ranges::random_access_range auto& range) {
    std::ranges::sort(range);
}

// ドメイン固有の制約のためのカスタムコンセプト
template<typename T>
concept Serializable = requires(const T& t) {
    { t.serialize() } -> std::convertible_to<std::string>;
};

template<Serializable T>
void save(const T& obj, const std::string& path);
```

### アンチパターン

- 可視名前空間での制約なしテンプレート (T.47)
- オーバーロードの代わりに関数テンプレートの特殊化 (T.144)
- `constexpr`で十分な場面でのテンプレートメタプログラミング (T.120)
- `using`の代わりに`typedef` (T.43)

## 標準ライブラリ (SL.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **SL.1** | 可能な限りライブラリを使用する |
| **SL.2** | 他のライブラリより標準ライブラリを好む |
| **SL.con.1** | C配列より`std::array`または`std::vector`を好む |
| **SL.con.2** | デフォルトで`std::vector`を好む |
| **SL.str.1** | 文字列を所有するには`std::string`を使用する |
| **SL.str.2** | 文字列を参照するには`std::string_view`を使用する |
| **SL.io.50** | `endl`を避ける（`'\n'`を使用 -- `endl`はフラッシュを強制する） |

```cpp
// SL.con.1 + SL.con.2: C配列よりvector/arrayを好む
const std::array<int, 4> fixed_data{1, 2, 3, 4};
std::vector<std::string> dynamic_data;

// SL.str.1 + SL.str.2: stringは所有、string_viewは観察
std::string build_greeting(std::string_view name) {
    return "Hello, " + std::string(name) + "!";
}

// SL.io.50: endlではなく'\n'を使用
std::cout << "result: " << value << '\n';
```

## 列挙型 (Enum.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **Enum.1** | マクロより列挙型を好む |
| **Enum.3** | 素の`enum`より`enum class`を好む |
| **Enum.5** | 列挙子にALL_CAPSを使用しない |
| **Enum.6** | 無名列挙型を避ける |

```cpp
// Enum.3 + Enum.5: スコープ付きenum、ALL_CAPSなし
enum class Color { red, green, blue };
enum class LogLevel { debug, info, warning, error };

// 悪い: 素のenumは名前をリークし、ALL_CAPSはマクロと衝突する
enum { RED, GREEN, BLUE };           // Enum.3 + Enum.5 + Enum.6 違反
#define MAX_SIZE 100                  // Enum.1 違反 -- constexprを使用
```

## ソースファイルと命名 (SF.*, NL.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **SF.1** | コードファイルには`.cpp`、インターフェースファイルには`.h`を使用する |
| **SF.7** | ヘッダーのグローバルスコープで`using namespace`を書かない |
| **SF.8** | すべての`.h`ファイルにインクルードガードを使用する |
| **SF.11** | ヘッダーファイルは自己完結的であるべき |
| **NL.5** | 名前に型情報をエンコードしない（ハンガリアン記法を使わない） |
| **NL.8** | 一貫した命名スタイルを使用する |
| **NL.9** | ALL_CAPSはマクロ名にのみ使用する |
| **NL.10** | `underscore_style`の名前を好む |

### ヘッダーガード

```cpp
// SF.8: インクルードガード（または#pragma once）
#ifndef PROJECT_MODULE_WIDGET_H
#define PROJECT_MODULE_WIDGET_H

// SF.11: 自己完結的 -- このヘッダーが必要とするすべてをインクルード
#include <string>
#include <vector>

namespace project::module {

class Widget {
public:
    explicit Widget(std::string name);
    const std::string& name() const;

private:
    std::string name_;
};

}  // namespace project::module

#endif  // PROJECT_MODULE_WIDGET_H
```

### 命名規約

```cpp
// NL.8 + NL.10: 一貫したunderscore_style
namespace my_project {

constexpr int max_buffer_size = 4096;  // NL.9: ALL_CAPSではない（マクロではない）

class tcp_connection {                 // underscore_styleのクラス
public:
    void send_message(std::string_view msg);
    bool is_connected() const;

private:
    std::string host_;                 // メンバーには末尾アンダースコア
    int port_;
};

}  // namespace my_project
```

### アンチパターン

- ヘッダーのグローバルスコープでの`using namespace std;` (SF.7)
- インクルード順序に依存するヘッダー (SF.10, SF.11)
- `strName`、`iCount`のようなハンガリアン記法 (NL.5)
- マクロ以外のALL_CAPS (NL.9)

## パフォーマンス (Per.*)

### 主要ルール

| ルール | 要約 |
|--------|------|
| **Per.1** | 理由なく最適化しない |
| **Per.2** | 時期尚早な最適化をしない |
| **Per.6** | 測定なしにパフォーマンスについて主張しない |
| **Per.7** | 最適化を可能にする設計をする |
| **Per.10** | 静的型システムに頼る |
| **Per.11** | 計算を実行時からコンパイル時に移す |
| **Per.19** | 予測可能なメモリアクセスをする |

### ガイドライン

```cpp
// Per.11: 可能な限りコンパイル時計算
constexpr auto lookup_table = [] {
    std::array<int, 256> table{};
    for (int i = 0; i < 256; ++i) {
        table[i] = i * i;
    }
    return table;
}();

// Per.19: キャッシュフレンドリーな連続データを好む
std::vector<Point> points;           // 良い: 連続
std::vector<std::unique_ptr<Point>> indirect_points; // 悪い: ポインタ追跡
```

### アンチパターン

- プロファイリングデータなしの最適化 (Per.1, Per.6)
- 明確な抽象化より「巧妙な」低レベルコードを選択 (Per.4, Per.5)
- データレイアウトとキャッシュ動作の無視 (Per.19)

## クイックリファレンスチェックリスト

C++作業を完了する前に:

- [ ] 素の`new`/`delete`なし -- スマートポインタまたはRAIIを使用 (R.11)
- [ ] オブジェクトは宣言時に初期化 (ES.20)
- [ ] 変数はデフォルトで`const`/`constexpr` (Con.1, ES.25)
- [ ] メンバー関数は可能な限り`const` (Con.2)
- [ ] 素の`enum`の代わりに`enum class` (Enum.3)
- [ ] `0`/`NULL`の代わりに`nullptr` (ES.47)
- [ ] ナローイング変換なし (ES.46)
- [ ] Cスタイルキャストなし (ES.48)
- [ ] 単一引数コンストラクタは`explicit` (C.46)
- [ ] ゼロの法則または5の法則が適用済み (C.20, C.21)
- [ ] 基底クラスのデストラクタはpublic virtualまたはprotected非virtual (C.35)
- [ ] テンプレートはコンセプトで制約 (T.10)
- [ ] ヘッダーのグローバルスコープに`using namespace`なし (SF.7)
- [ ] ヘッダーにインクルードガードがあり自己完結的 (SF.8, SF.11)
- [ ] ロックはRAII（`scoped_lock`/`lock_guard`）を使用 (CP.20)
- [ ] 例外はカスタム型、値でスロー、参照でキャッチ (E.14, E.15)
- [ ] `std::endl`の代わりに`'\n'` (SL.io.50)
- [ ] マジックナンバーなし (ES.45)
