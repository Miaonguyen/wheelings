# Deploy Wheelings lên Sepolia (≈5 phút, phí ≈ 0)

Cần: ví (MetaMask / OKX / Rabby / Bitget… bất kỳ) đang ở mạng **Sepolia**, có chút Sepolia ETH.

## 1. Mở Remix
https://remix.ethereum.org → tab **File explorer** → tạo file mới `Wheelings.sol` → dán toàn bộ nội dung file `contracts/Wheelings.sol`.

## 2. Compile (QUAN TRỌNG: bật optimizer)
Tab **Solidity compiler**:
- Compiler: **0.8.26**
- Mở **Advanced Configurations**:
  - ✅ **Enable optimization**, runs = **200**
  - EVM version: **cancun**
- Bấm **Compile Wheelings.sol** → dấu tick xanh.

> Không bật optimization thì contract nặng 36.766 bytes > giới hạn 24.576 → deploy lỗi.

## 3. Deploy
Tab **Deploy & run transactions**:
- Environment: **Injected Provider – (tên ví của bạn)**, kiểm tra hiện `Sepolia (11155111)`.
- Contract: **Wheelings**
- Bấm mũi tên cạnh **Deploy** để mở 2 ô tham số:
  - `core_`: `0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4`
  - `squeeks_`: `0xc4c7982657f00509548f3a3a41db7fa439a6856b`
- Bấm **transact** → xác nhận trong ví.

Gas limit sẽ khoảng **36 triệu** – bình thường, vì Sepolia hiện tính phí tạo state cao (contract 21–22 KB khác trên Sepolia cũng ~33–35 triệu). Giá gas Sepolia đang ~0.00000002 gwei nên phí gần như 0. Nếu ví cảnh báo "gas cao", cứ xác nhận.

## 4. Gửi lại cho Claude
Copy từ Remix (mục Deployed Contracts / terminal):
- **Địa chỉ contract** (0x…)
- **Tx hash** của giao dịch deploy

Claude sẽ: gắn địa chỉ vào `index.html`, verify mã nguồn trên Sourcify, chạy thử thật trên Sepolia, rồi đưa bản cuối để up GitHub + 1 job IMD.

## Kiểm tra nhanh trong Remix (tuỳ chọn)
Ở contract vừa deploy, bấm `currentRound` (≈ số round hiện tại, >1400) và `settledThroughRound` (round SqueekCore đã settle). Ra số là contract đã đọc được SqueekCore thật.
