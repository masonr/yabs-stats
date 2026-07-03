from datetime import datetime

def main():

    print("YABS Stats Updater")
    print("------------------")
    print(f"Current UTC: {datetime.utcnow().isoformat()}")

if __name__ == "__main__":
    main()